// src/orchestration/intent.ts
import { Env } from "../types";
import { AssetDescriptor } from "./types";

export type IntentState = 'ANCHOR_TAIL' | 'REBIND_ROOT' | 'CROSS_FUSION' | 'SWITCH_BRANCH' | 'DETACH_RESET';

export interface BranchCatalogItem {
  branch_id: string;
  topic?: string;
  is_media?: boolean;
  last_summary?: string;
  is_active?: boolean;
}

export interface MultiRoundIntentAssetOptions {
  hasNewUploads?: boolean;
  newUploadModalities?: string[];
  assets?: AssetDescriptor[];
  sessionAssetLedger?: Array<{
    asset_id: string;
    filename?: string;
    modality: string;
    introduced_round?: number;
    branch_id?: string;
  }>;
  activeBranchSummary?: string;
  activeBranchId?: string;
  branchCatalog?: BranchCatalogItem[];
}

export interface IntentClassificationResult {
  intent: IntentState;
  targetBranchId?: string;
}

/**
 * Native JEV Choice: Multi-round intent classification with Asset-Aware Hard Gate
 * Deterministic partitioning:
 * - With NEW Heavy Media (image/audio/pdf): Binary Choice: CROSS_FUSION vs DETACH_RESET
 * - Without NEW Heavy Media: Multi-way Choice: ANCHOR_TAIL vs REBIND_ROOT vs SWITCH_BRANCH vs DETACH_RESET
 * 
 * Zero heuristic regex keyword matching: Uses comprehensive objective state facts and pure semantic criteria.
 */
export async function classifyMultiRoundIntent(
  env: Env,
  currentPrompt: string,
  hasPreviousRound: boolean,
  previousRoundSummary?: string,
  hadMediaAssets?: boolean,
  assetOptions?: MultiRoundIntentAssetOptions
): Promise<IntentClassificationResult> {
  // If first round ever, naturally zero history
  if (!hasPreviousRound) {
    return { intent: 'DETACH_RESET' };
  }

  const newModalities = assetOptions?.newUploadModalities || [];
  const assets = assetOptions?.assets || [];
  const hasNewHeavyMedia = newModalities.some(m => m === 'image' || m === 'audio' || m === 'pdf') ||
    assets.some(a => a.is_new && (a.modality === 'image' || a.modality === 'audio'));

  // 1. Build Session Assets Catalog string (objective ledger)
  let catalogStr = '无历史资产';
  const ledger = assetOptions?.sessionAssetLedger;
  if (ledger && ledger.length > 0) {
    catalogStr = ledger.map((item, idx) => 
      `[资产 ${idx + 1}]: ID: ${item.asset_id}, 文件名: "${item.filename || 'attachment'}", 模态: ${item.modality}${item.introduced_round ? `, 首次引入轮次: ${item.introduced_round}` : ''}`
    ).join('; ');
  } else if (assets && assets.length > 0) {
    const historical = assets.filter(a => !a.is_new);
    if (historical.length > 0) {
      catalogStr = historical.map((item, idx) => 
        `[资产 ${idx + 1}]: ID: ${item.asset_id}, 文件名: "${item.filename || 'attachment'}", 模态: ${item.modality}`
      ).join('; ');
    }
  }

  // 2. Build Lineage / Previous Task Summary string
  const validContextSummary = assetOptions?.activeBranchSummary || previousRoundSummary || '无有效先验产物';

  // =========================================================================
  // CASE 1: With NEW heavy media (image, audio, PDF) uploaded in this follow-up
  // Binary Choice: CROSS_FUSION vs DETACH_RESET
  // =========================================================================
  if (hasNewHeavyMedia) {
    const modalityStr = newModalities.length > 0 ? newModalities.join(', ') : 'multimodal media';
    try {
      if (env.AI) {
        // 1. Primary: Native Clef-Flash Binary Decision
        try {
          const stateBlock = `[会话客观事实账本]\n- 历史已存资产目录: ${catalogStr}\n- 本轮是否有新上传媒体: 是 (${modalityStr})\n- 最近有效任务产物背景: ${validContextSummary}\n\n[用户最新指令]: ${currentPrompt}`;
          const jevRes = await env.AI.run('@cf/cloudflare/clef-flash', {
            state: stateBlock,
            questions: {
              multi_round_intent: {
                type: 'choice',
                instructions: '结合客观事实账本与用户最新指令，判断用户针对新上传资产的意图（二选一）：',
                criteria: {
                  CROSS_FUSION: '多源融合/跨轮对比：用户希望将本轮新上传的媒体资产与历史已存资产或前文成果进行横向对比、融合、结合分析或继承参照。',
                  DETACH_RESET: '独立全新任务：用户希望针对本轮新上传的媒体资产独立开展全新的任务，无需结合或对比历史资产/产物。'
                }
              }
            }
          });
          const decision = jevRes?.result?.answers?.multi_round_intent?.choice ||
                           jevRes?.answers?.multi_round_intent?.choice ||
                           jevRes?.multi_round_intent?.choice ||
                           jevRes?.result?.answers?.multi_round_intent?.decision ||
                           jevRes?.answers?.multi_round_intent?.decision ||
                           jevRes?.multi_round_intent?.decision;
          if (decision === 'CROSS_FUSION' || decision === 'DETACH_RESET') {
            return { intent: decision };
          }
        } catch (clefErr) {
          console.warn("Clef-Flash binary choice error, falling back to Llama-3.1:", clefErr);
        }

        // 2. Secondary High-Reliability: Llama-3.1-8B-FP8
        const systemPrompt = `You are the NanoMesh JEV Intent Classifier. The user uploaded NEW media file(s) in this follow-up round.
Classify into exactly ONE of:
- CROSS_FUSION: User asks to compare, fuse, combine, or cross-reference this new media with historical assets or previous outputs.
- DETACH_RESET: User wants to start a completely brand new, independent task with this new media, ignoring prior assets.

Output JSON only: {"intent": "CROSS_FUSION" | "DETACH_RESET"}`;

        const userMessage = `[Session Assets]: ${catalogStr}\n[New Media Uploaded]: ${modalityStr}\n[Previous Valid Output]: ${validContextSummary}\n[Current User Query]: ${currentPrompt}`;

        const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 25,
          temperature: 0.0
        });

        const responseText = aiResponse?.response || '';
        const match = responseText.match(/\"intent\"\s*:\s*\"(CROSS_FUSION|DETACH_RESET)\"/i);
        if (match) {
          return { intent: match[1].toUpperCase() as IntentState };
        }
      }
    } catch (e) {
      console.warn("Asset-aware JEV binary classification failed:", e);
    }

    // Conservative safe fallback for new heavy media
    return { intent: 'DETACH_RESET' };
  }

  // =========================================================================
  // CASE 2: Without NEW heavy media (Standard Multi-way choice)
  // ANCHOR_TAIL vs REBIND_ROOT vs SWITCH_BRANCH vs DETACH_RESET
  // =========================================================================
  const branchCatalog = assetOptions?.branchCatalog || [];
  const otherBranches = branchCatalog.filter(b => !b.is_active && b.last_summary && b.last_summary.trim().length > 0);
  const activeBranch = branchCatalog.find(b => b.is_active) || {
    branch_id: assetOptions?.activeBranchId || 'main',
    topic: '当前任务',
    last_summary: validContextSummary,
    is_media: hadMediaAssets
  };

  const hasHistoricalMedia = !!(hadMediaAssets || (ledger && ledger.some(a => a.modality === 'image' || a.modality === 'audio')) || (assets && assets.some(a => a.modality === 'image' || a.modality === 'audio')));

  const otherBranchesText = otherBranches.length > 0
    ? '\n- 历史其它任务分支目录:\n' + otherBranches.map(b =>
        `  * 【分支 ID: ${b.branch_id}】:\n    - 业务领域/主题: "${b.topic || '历史任务'}"\n    - 关联素材属性: ${b.is_media ? '挂载了多模态媒体原件' : '纯文本/代码交互'}\n    - 历史产物基底: "${(b.last_summary || '').slice(0, 180).replace(/\s+/g, ' ')}"`
      ).join('\n')
    : '\n- 历史其它任务分支目录: 无';

  const activeBranchText = `- 当前活跃任务分支: 【分支 ID: ${activeBranch.branch_id}】:\n  - 业务领域/主题: "${activeBranch.topic || '当前任务'}"\n  - 关联素材属性: ${activeBranch.is_media ? '挂载了多模态媒体原件' : '纯文本/代码交互'}\n  - 最新产物基底: "${(activeBranch.last_summary || validContextSummary).slice(0, 180).replace(/\s+/g, ' ')}"`;

  const stateBlock = `[会话客观事实账本]
- 历史原始媒体资产清单: ${catalogStr} (存在底层多模态原始素材: ${hasHistoricalMedia ? '是' : '否'})
- 本轮是否有新上传媒体: 否
${activeBranchText}
${otherBranchesText}
- 当前焦点与上下文所处领域: "${activeBranch.topic || '当前任务'}"

[用户最新指令]: ${currentPrompt}`;

  try {
    if (env.AI) {
      // 1. Primary: Native Clef-Flash Decision Model
      try {
        const criteria: Record<string, string> = {
          ANCHOR_TAIL: '【当前分支产物基底推进】：指令所属业务领域属于【当前活跃任务分支】，且该指令所需的全部上下文和事实信息，已自洽充分地包含在当前活跃分支的【最新产物基底】中。无需回溯感知任何未提取的原始底层介质。',
          DETACH_RESET: '【正交独立全新任务】：指令开启了完全独立的新任务，与当前活跃分支及所有历史分支的主题、产物与先验资产均无语义依赖。'
        };

        if (hasHistoricalMedia) {
          criteria.REBIND_ROOT = '【底层原始资产穿透探查】：指令所属业务领域属于【当前活跃任务分支】，但指令所需的信息在下游抽象中未被包含或已经丢失，仅凭【最新产物基底】文本无法充分解答，必须穿透回溯至该分支底层的原始多模态物理介质本身进行重新感知。';
        }

        if (otherBranches.length > 0) {
          criteria.SWITCH_BRANCH = '【切换至非当前历史分支】：指令脱离了【当前活跃任务分支】的业务领域，转而依赖【历史其它任务分支目录】中某个非当前分支的主题上下文、沉淀产物或历史介质。必须将工作焦点转移至该目标历史分支。';
        }

        const questions: Record<string, any> = {
          multi_round_intent: {
            type: 'choice',
            instructions: '结合客观事实账本中各分支的业务领域与用户最新指令，判断用户指令的信息诉求来源与依赖关系：',
            criteria
          }
        };

        if (otherBranches.length > 0) {
          const branchCriteria: Record<string, string> = {};
          otherBranches.forEach(b => {
            branchCriteria[b.branch_id] = `主题: ${b.topic || '任务产物'}, 产物: ${(b.last_summary || '').slice(0, 100).replace(/\s+/g, ' ')}`;
          });
          questions.target_branch = {
            type: 'choice',
            instructions: '若用户指代或依赖了历史其它分支，选择与指令最匹配的目标分支 ID：',
            criteria: branchCriteria
          };
        }

        const jevRes = await env.AI.run('@cf/cloudflare/clef-flash', {
          state: stateBlock,
          questions
        });

        const decision = jevRes?.result?.answers?.multi_round_intent?.choice ||
                         jevRes?.answers?.multi_round_intent?.choice ||
                         jevRes?.multi_round_intent?.choice ||
                         jevRes?.result?.answers?.multi_round_intent?.decision ||
                         jevRes?.answers?.multi_round_intent?.decision ||
                         jevRes?.multi_round_intent?.decision;

        if (decision === 'SWITCH_BRANCH') {
          const targetChoice = jevRes?.result?.answers?.target_branch?.choice ||
                               jevRes?.answers?.target_branch?.choice ||
                               jevRes?.target_branch?.choice;
          const matchedBranch = otherBranches.find(b => b.branch_id === targetChoice);
          if (matchedBranch) {
            return { intent: 'SWITCH_BRANCH', targetBranchId: matchedBranch.branch_id };
          }
          // Graph Invariant: If target is not among the other inactive branches,
          // it cannot be an external switch. It belongs to active branch domain!
          return { intent: (activeBranch.is_media && hasHistoricalMedia) ? 'REBIND_ROOT' : 'ANCHOR_TAIL' };
        }

        if (decision === 'ANCHOR_TAIL' || decision === 'REBIND_ROOT' || decision === 'DETACH_RESET') {
          return { intent: decision };
        }
      } catch (clefErr) {
        console.warn("Clef-Flash primary invocation error, falling back to Llama-3.1-FP8:", clefErr);
      }

      // 2. Secondary High-Reliability: Llama-3.1-8B-FP8 structured classification
      const systemPrompt = `You are the NanoMesh JEV Intent Classifier.
Analyze the user query's semantic dependency against the session ledger and task branches:
- ANCHOR_TAIL: User's query belongs to the CURRENT active branch, and all required facts/context are already sufficiently present in the active branch's latest product summary. No raw perceptual re-examination of underlying media is required.
- REBIND_ROOT: User's query belongs to the CURRENT active branch, but the required information is NOT present in the latest product summary text and necessitates re-perceiving or re-inspecting the underlying raw multimodal source assets of this branch.
- SWITCH_BRANCH: User's query departs from the CURRENT active branch's domain and targets a DIFFERENT inactive historical branch listed in the historical branch catalog.
- DETACH_RESET: User's query is a brand-new independent task with zero dependency on any branch or asset.

Output JSON only: {"intent": "ANCHOR_TAIL" | "REBIND_ROOT" | "SWITCH_BRANCH" | "DETACH_RESET", "target_branch_id": "<branch_id if SWITCH_BRANCH, else null>"}`;

      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: stateBlock }
        ],
        max_tokens: 40,
        temperature: 0.0
      });

      const responseText = aiResponse?.response || '';
      const match = responseText.match(/\"intent\"\s*:\s*\"(ANCHOR_TAIL|REBIND_ROOT|SWITCH_BRANCH|DETACH_RESET)\"/i);
      if (match) {
        const parsedIntent = match[1].toUpperCase() as IntentState;
        if (parsedIntent === 'SWITCH_BRANCH') {
          const branchMatch = responseText.match(/\"target_branch_id\"\s*:\s*\"([^\"]+)\"/i);
          const targetId = branchMatch ? branchMatch[1] : undefined;
          const matchedBranch = otherBranches.find(b => b.branch_id === targetId);
          if (matchedBranch) {
            return { intent: 'SWITCH_BRANCH', targetBranchId: matchedBranch.branch_id };
          }
          return { intent: (activeBranch.is_media && hasHistoricalMedia) ? 'REBIND_ROOT' : 'ANCHOR_TAIL' };
        }
        return { intent: parsedIntent };
      }
    }
  } catch (e) {
    console.warn("JEV classification failed:", e);
  }

  // Safe conservative fallback when classification cannot be resolved: treat as detached independent query
  return { intent: 'DETACH_RESET' };
}
