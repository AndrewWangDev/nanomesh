// src/orchestration/competence.ts
import { Env } from "../types";
import { DAGRole, DAGTemplate, ModelMetadata } from "./types";

export const SENTINEL_UNREACHABLE_TEMPLATE_ID = '__NONE_OF_ABOVE__';

export const SENTINEL_UNREACHABLE_TEMPLATE: DAGTemplate = {
  template_id: SENTINEL_UNREACHABLE_TEMPLATE_ID,
  name_zh: '∅ 意图不可达',
  name_en: '∅ Unreachable',
  desc_zh: '当前提供的任何候选工作流均无法满足、承接或解决用户的本轮指令诉求。',
  desc_en: 'None of the candidate workflows can satisfy the user request.',
  head_modalities: ['text'],
  tail_modalities: ['text'],
  roles: [],
  priority: -1,
  status: 'active'
};

/**
 * Step 2: JEV Scoring for Candidate Templates with Fast-Failed Sentinel & Gating
 * Selects Top 3 candidate templates or triggers Fast-Failed unreachable sentinel.
 */
export async function rankCandidateTemplates(
  env: Env,
  candidateTemplates: DAGTemplate[],
  userPrompt: string,
  userModalities?: string[]
): Promise<DAGTemplate[]> {
  if (candidateTemplates.length === 0) {
    return [SENTINEL_UNREACHABLE_TEMPLATE];
  }

  const hasMediaInput = userModalities && userModalities.some(m => m !== 'text');
  const evaluationState = hasMediaInput
    ? `用户挂载了输入介质 [${userModalities.join(', ')}]，指令诉求：${userPrompt}`
    : userPrompt;

  // Fast JEV Score via Workers AI (Primary Clef-Flash + Secondary Llama-3.1-FP8)
  try {
    if (env.AI) {
      // 1. Primary: Clef-Flash / JEV score ranking
      try {
        const questions: Record<string, any> = {};
        candidateTemplates.forEach(t => {
          questions[t.template_id] = {
            type: 'score',
            instructions: `评估工作流模板 "${t.name_zh}: ${t.desc_zh}" 对承接并完成用户任务 "${userPrompt}" 的胜任度打分：`,
            criteria: [
              "该工作流完全不相关或无法承接用户任务诉求",
              "该工作流能部分承接或作为通用流水线处理用户任务",
              "该工作流完全匹配并能高质量胜任用户任务诉求"
            ]
          };
        });
        const clefRes = await env.AI.run('@cf/cloudflare/clef-flash', {
          state: evaluationState,
          questions
        });
        if (clefRes) {
          const ans: any = clefRes?.answers || clefRes;
          const scored = [...candidateTemplates].map(t => {
            const entry = ans[t.template_id];
            const rawScore = typeof entry?.score === 'number'
              ? entry.score
              : (typeof entry?.value === 'number' ? entry.value : (t.priority / 10));
            // Clef-Flash score against 3 levels [0, 1, 2] is an expected index in [0.0, 2.0].
            // Normalize to 0-100 scale: (rawScore / 2.0) * 100
            const normalizedScore = rawScore <= 2.0
              ? (rawScore / 2.0) * 100
              : rawScore;
            return {
              template: t,
              score: normalizedScore
            };
          }).sort((a, b) => b.score - a.score);

          // Fast-Failed Dual Gate: If maximum relevance score is below 25, no template is capable!
          const maxScore = scored[0]?.score ?? 0;
          if (maxScore < 25) {
            return [SENTINEL_UNREACHABLE_TEMPLATE];
          }

          return scored.map(s => s.template).slice(0, 3);
        }
      } catch (clefErr) {
        console.warn("Clef-Flash score failed, trying Llama-3.1-FP8:", clefErr);
      }

      // 2. Secondary: Llama-3.1-8B-FP8 JSON array ranker with Relational Sentinel
      const templateSummaries = [
        ...candidateTemplates.map((t) => `ID: ${t.template_id} | Name: ${t.name_zh} | Desc: ${t.desc_zh}`),
        `ID: ${SENTINEL_UNREACHABLE_TEMPLATE_ID} | Name: 无匹配工作流 | Desc: 当前给出的所有候选工作流在技术、模态或能力上均完全无法承接用户的诉求（例如要求视频生成或不可达系统能力）。`
      ].join('\n');

      const prompt = `You are a strict DAG Workflow Router.
Evaluate user request: "${userPrompt}"
Against candidate workflow templates:
${templateSummaries}

Rules:
1. If any candidate workflow template can fulfill, extract, understand, or process the user's task or question (including visual question answering, style/layout analysis, text generation, or speech), rank it high.
2. ONLY choose ["${SENTINEL_UNREACHABLE_TEMPLATE_ID}"] if the request is genuinely impossible for any of the templates to handle (e.g. video generation, hardware control, or unfulfillable physical actions).
3. Rank best suitable template IDs in descending order.

Return JSON array only: ["id1", "id2", "id3"] or ["${SENTINEL_UNREACHABLE_TEMPLATE_ID}"]`;

      const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 60,
        temperature: 0.0
      });

      const text = aiRes?.response || '';
      const match = text.match(/\[(.*?)\]/);
      if (match) {
        const topIds: string[] = JSON.parse(match[0]);
        // If top-ranked ID is the sentinel, trigger Fast-Failed Unreachable!
        if (topIds[0] === SENTINEL_UNREACHABLE_TEMPLATE_ID) {
          return [SENTINEL_UNREACHABLE_TEMPLATE];
        }

        const idMap = new Map(candidateTemplates.map(t => [t.template_id, t]));
        const ordered: DAGTemplate[] = [];
        for (const id of topIds) {
          if (idMap.has(id)) ordered.push(idMap.get(id)!);
        }
        for (const t of candidateTemplates) {
          if (!ordered.includes(t)) ordered.push(t);
        }
        return ordered.slice(0, 3);
      }
    }
  } catch (e) {
    console.warn("JEV template ranking failed, falling back to priority sort:", e);
  }

  // Fallback: sort by priority descending
  return [...candidateTemplates].sort((a, b) => b.priority - a.priority).slice(0, 3);
}

export interface RoleResolutionResult {
  role: DAGRole;
  selectedModels: ModelMetadata[]; // Candidate models passing Competence Law
  downgraded: boolean;
  activeTag: string;
  compensationPrompt?: string;
  downgradeEvent?: { original_tag: string; fallback_tag: string };
}

/**
 * Step 2: Competence Law (胜任定律) and Intersection Operation with Tag Downgrade
 * 
 * Rules:
 * (1) Role.in_modalities ⊆ Model.in_modalities
 * (2) Role.out_modalities ⊆ Model.out_modalities
 * (3) Role.requisition_tag ⊆ Model.tags
 */
export function resolveRoleCompetence(
  role: DAGRole,
  candidateModels: ModelMetadata[]
): RoleResolutionResult {
  const roleIn = new Set(role.in_modalities);
  const roleOut = new Set(role.out_modalities);

  const tags = role.requisition_tags.length ? role.requisition_tags : ['#general'];
  let activeTag = tags[0];
  let downgraded = false;
  let downgradeEvent: { original_tag: string; fallback_tag: string } | undefined;
  let matchedModels: ModelMetadata[] = [];

  for (let i = 0; i < tags.length; i++) {
    const currentTag = tags[i];
    activeTag = currentTag;

    // Perform Intersection Operation with Competence Law
    matchedModels = candidateModels.filter(m => {
      const modelIn = new Set(m.modalities);
      const modelTags = new Set(m.tags);

      // (1) Role.in ⊆ Model.in
      for (const reqIn of roleIn) {
        if (!modelIn.has(reqIn)) return false;
      }

      // (2) Role.out ⊆ Model.out (Model must support outputting text if required)
      if (roleOut.has('text') && !modelIn.has('text') && !m.modalities.includes('text')) {
        // Most models output text
      }

      // (3) Role.tag ⊆ Model.tags
      if (!modelTags.has(currentTag)) {
        return false;
      }

      return true;
    });

    if (matchedModels.length > 0) {
      if (i > 0) {
        downgraded = true;
        downgradeEvent = { original_tag: tags[0], fallback_tag: currentTag };
      }
      break;
    }
  }

  // If even after trying all tags, no model was found, fall back to matching by modalities only
  if (matchedModels.length === 0) {
    matchedModels = candidateModels.filter(m => {
      const modelIn = new Set(m.modalities);
      for (const reqIn of roleIn) {
        if (!modelIn.has(reqIn)) return false;
      }
      return true;
    });
    if (matchedModels.length > 0) {
      downgraded = true;
      downgradeEvent = { original_tag: tags[0], fallback_tag: '#modality_fallback' };
    }
  }

  if (matchedModels.length === 0) {
    throw new Error(`岗位 [${role.name_zh}] 无法在可用节点池中匹配到胜任模型，调度中止。`);
  }

  // Extract compensation prompt if downgraded
  let compensationPrompt: string | undefined;
  if (downgraded && role.compensation_prompts) {
    compensationPrompt = role.compensation_prompts[activeTag] || 
      role.compensation_prompts[Object.keys(role.compensation_prompts)[0]];
  }

  return {
    role,
    selectedModels: matchedModels,
    downgraded,
    activeTag,
    compensationPrompt,
    downgradeEvent
  };
}
