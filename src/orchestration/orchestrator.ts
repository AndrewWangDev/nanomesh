import { Env } from "../types";
import { classifyMultiRoundIntent, IntentState } from "./intent";
import { hardFilterModels, filterTemplatesBySubsistence } from "./subsistence";
import { rankCandidateTemplates, resolveRoleCompetence, SENTINEL_UNREACHABLE_TEMPLATE_ID, SENTINEL_UNREACHABLE_TEMPLATE } from "./competence";
import { generatePromptEmbedding, scoreAndRankRoleModels } from "./scoring";
import { performGatewaySafetyAudit } from "./safety";
import { 
  DAGRole, 
  DAGTemplate, 
  InstantiatedDAG, 
  InstantiatedDAGNode, 
  ModelMetadata, 
  UnifiedProtocolEnvelope 
} from "./types";

export interface OrchestrationOptions {
  reRouteMode?: 'normal' | 'switch_template' | 'switch_model';
  chosenTemplateId?: string;
  chosenRoleModels?: Record<string, string>; // role_id -> model_id
  customRolePrompts?: Record<string, string>; // role_id -> custom_prompt
  customNodePrompt?: string; // fallback single node custom prompt
  hasPreviousRound?: boolean;
  previousRoundSummary?: string;
  hadMediaAssets?: boolean;
  hasNewUploads?: boolean;
  newUploadModalities?: string[];
  sessionAssetLedger?: Array<{
    asset_id: string;
    filename?: string;
    modality: string;
    introduced_round?: number;
    branch_id?: string;
  }>;
  activeBranchId?: string;
  activeBranchSummary?: string;
  branchCatalog?: Array<{
    branch_id: string;
    topic?: string;
    is_media?: boolean;
    last_summary?: string;
    is_active?: boolean;
  }>;
  disableBrowserInference?: boolean;
}

function safeJsonParse<T>(raw: any, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    try {
      const cleaned = raw.replace(/\\#/g, '#').replace(/\\([,\[\]])/g, '$1');
      if (cleaned.startsWith('[') && !cleaned.includes('"')) {
        const parts = cleaned.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        return parts as any;
      }
      return JSON.parse(cleaned);
    } catch (e2) {
      return fallback;
    }
  }
}

export async function runOrchestrationPipeline(
  env: Env,
  envelope: UnifiedProtocolEnvelope,
  options: OrchestrationOptions = {}
): Promise<InstantiatedDAG> {
  // ----------------------------------------------------
  // Guardrail 1: Gateway Safety Audit (Fast-Failed for Malicious/Illegal Queries)
  // ----------------------------------------------------
  const safetyAudit = await performGatewaySafetyAudit(env, envelope.instruction_payload);
  if (!safetyAudit.isSafe) {
    const firewallRole: DAGRole = {
      role_id: 'role_edge_firewall',
      name_zh: '🛡️ 边界防御网关',
      name_en: '🛡️ Edge Firewall',
      in_modalities: ['text'],
      out_modalities: ['text'],
      in_degree: 0,
      out_degree: 0,
      requisition_tags: ['security_blocked']
    };

    const firewallModel: ModelMetadata = {
      model_id: 'model_edge_firewall',
      display_name: 'Edge Firewall 3.0',
      provider: 'NanoMesh Gateway',
      endpoint: '',
      modalities: ['text'],
      tags: ['security'],
      context_window: 0,
      max_concurrency: 0,
      active_connections: 0,
      precision: 1,
      user_rating: 5,
      usage_count: 0,
      cost_per_1k_tokens: 0,
      status: 'blocked',
      is_generalist: 0,
      prior_score: 0,
      scenario_anchors: []
    };

    return {
      template: {
        template_id: 'tpl_edge_firewall',
        name_zh: '🛡️ 边界防御网关',
        name_en: '🛡️ Edge Firewall',
        desc_zh: '安全合规网关审计阻断',
        desc_en: 'Security Policy Guardrail Blocked',
        head_modalities: ['text'],
        tail_modalities: ['text'],
        roles: [firewallRole],
        priority: 0,
        status: 'blocked'
      },
      candidate_templates: [],
      nodes: [{
        role: firewallRole,
        selected_model: firewallModel,
        standby_models: [],
        score_details: {
          model: firewallModel,
          score: 0,
          sim: 0,
          concurrency_penalty: 0,
          specialist_score: 0
        },
        downgraded: false,
        claimed_assets: []
      }],
      reasoning_trace: {
        intent_state: null,
        is_multi_round: false,
        subsistence_filtered_count: 0,
        selected_template_id: 'tpl_edge_firewall',
        downgrade_events: []
      },
      is_security_violation: true
    };
  }

  // ----------------------------------------------------
  // Step 0: Multi-round Intent Classification & Asset Reset
  // ----------------------------------------------------
  let intentState: IntentState | null = null;
  let targetBranchId: string | undefined = undefined;
  const isReRoute = options.reRouteMode === 'switch_template' || options.reRouteMode === 'switch_model';

  // Deep clone assets manifest to ensure object isolation
  envelope.assets_manifest = envelope.assets_manifest.map(a => ({ ...a }));

  if (isReRoute) {
    // Case 1 & Case 2: Re-routing the current task (Canvas model/prompt modification)
    // Reset all assets consumed flag to false so that head nodes can re-claim and re-process them.
    // Strictly NOT a multi-round chat follow-up! IntentState MUST be null.
    envelope.assets_manifest.forEach(a => { a.consumed = false; });
    intentState = null;

    // Retain previous round background for incremental modification tasks if no raw media assets
    // Or if re-routing a text-only refinement template (like tpl_direct_chat)
    const isTextOnlyTemplate = options.chosenTemplateId === 'tpl_direct_chat';
    if (isTextOnlyTemplate) {
      envelope.assets_manifest = envelope.assets_manifest.filter(a => a.modality === 'text_doc' || a.modality === 'text');
    }
    const hasMedia = envelope.assets_manifest.some(a => a.modality === 'image' || a.modality === 'audio');
    if ((!hasMedia || isTextOnlyTemplate) && options.previousRoundSummary && !envelope.instruction_payload.includes('[上轮产物背景:')) {
      envelope.instruction_payload = `[上轮产物背景: ${options.previousRoundSummary}]\n用户追问: ${envelope.instruction_payload}`;
    }
  } else if (options.hasPreviousRound) {
    // Case 3: Follow-up question across rounds with JEV classification (Asset-Aware & Branch-Aware)
    const classification = await classifyMultiRoundIntent(
      env,
      envelope.instruction_payload,
      true,
      options.previousRoundSummary,
      options.hadMediaAssets,
      {
        hasNewUploads: options.hasNewUploads,
        newUploadModalities: options.newUploadModalities,
        assets: envelope.assets_manifest,
        sessionAssetLedger: options.sessionAssetLedger,
        activeBranchSummary: options.activeBranchSummary,
        activeBranchId: options.activeBranchId,
        branchCatalog: options.branchCatalog
      }
    );
    intentState = classification.intent;
    targetBranchId = classification.targetBranchId;

    const summaryContext = options.activeBranchSummary || options.previousRoundSummary;

    if (intentState === 'ANCHOR_TAIL') {
      // State A: Local tweak on previous output.
      // Strip heavy media assets (image, audio, pdf), keep text/document assets
      envelope.assets_manifest = envelope.assets_manifest.filter(a => a.modality === 'text_doc' || a.modality === 'text');
      envelope.assets_manifest.forEach(a => { a.consumed = false; });
      if (summaryContext && !envelope.instruction_payload.includes('[上轮产物背景:')) {
        envelope.instruction_payload = `[上轮产物背景: ${summaryContext}]\n用户追问: ${envelope.instruction_payload}`;
      }
    } else if (intentState === 'REBIND_ROOT') {
      // State B: Re-bind to raw historical assets.
      // Re-mount historical media assets, reset consumed flags so head nodes re-read raw assets.
      envelope.assets_manifest.forEach(a => { a.consumed = false; });
      // In State B, keep instruction_payload pure to prevent historical hallucination/bias!
    } else if (intentState === 'CROSS_FUSION') {
      // State D: Cross-round fusion / comparison.
      // Keep both historical assets and newly uploaded assets, reset consumed flags.
      envelope.assets_manifest.forEach(a => { a.consumed = false; });
      if (summaryContext && !envelope.instruction_payload.includes('[历史产物参考:')) {
        envelope.instruction_payload = `[历史产物参考: ${summaryContext}]\n对比融合指令: ${envelope.instruction_payload}`;
      }
    } else if (intentState === 'SWITCH_BRANCH') {
      // State E: Switch back to a historical branch (Memory Springback)
      const targetBranch = (options.branchCatalog || []).find(b => b.branch_id === targetBranchId) ||
                           (options.branchCatalog || []).find(b => b.is_media) ||
                           (options.branchCatalog || []).find(b => !b.is_active);
      const branchSummary = targetBranch?.last_summary || '';

      if (targetBranch?.is_media) {
        // If target was a media branch, re-bind media assets
        envelope.assets_manifest.forEach(a => { a.consumed = false; });
      } else {
        // If target was a text/code branch, strip heavy media assets (image, audio, pdf)
        envelope.assets_manifest = envelope.assets_manifest.filter(a => a.modality === 'text_doc' || a.modality === 'text');
        envelope.assets_manifest.forEach(a => { a.consumed = false; });
      }

      if (branchSummary && !envelope.instruction_payload.includes('[关联分支历史产物:')) {
        envelope.instruction_payload = `[关联分支历史产物: ${branchSummary}]\n用户增量指令: ${envelope.instruction_payload}`;
      }
    } else if (intentState === 'DETACH_RESET') {
      // State C: Brand-new task (Auto-Detach).
      // If new assets exist, drop historical assets (is_new === false) so we strictly process the new task.
      // If NO new assets exist, force assets_manifest to empty [] to construct a 100% clean Net Envelope!
      const hasNewAssets = envelope.assets_manifest.some(a => a.is_new);
      if (hasNewAssets) {
        envelope.assets_manifest = envelope.assets_manifest.filter(a => a.is_new);
      } else {
        envelope.assets_manifest = [];
      }
      envelope.assets_manifest.forEach(a => { a.consumed = false; });
    }
  }

  // Ensure empty assets manifest has a virtual text asset
  if (envelope.assets_manifest.length === 0) {
    envelope.assets_manifest.push({
      asset_id: 'virtual-text-asset',
      modality: 'text',
      mime_type: 'text/plain',
      file_size: envelope.instruction_payload.length,
      in_memory_text: envelope.instruction_payload,
      consumed: false,
      source_digest: 'text-digest'
    });
  }

  const userModalities = Array.from(new Set(envelope.assets_manifest.map(a => a.modality)));

  // ----------------------------------------------------
  // Step 1: Load DB metadata & Hard Filter & Subsistence Law
  // ----------------------------------------------------
  const rawTemplates = await env.DB.prepare(
    "SELECT * FROM dag_templates WHERE status = 'active'"
  ).all<any>();

  const allTemplates: DAGTemplate[] = (rawTemplates.results || []).map(r => ({
    template_id: r.template_id,
    name_zh: r.template_id === 'tpl-vision-ocr-summary' ? '视觉多模态全景分析' : r.name_zh,
    name_en: r.template_id === 'tpl-vision-ocr-summary' ? 'Multimodal Vision Analysis' : r.name_en,
    desc_zh: r.template_id === 'tpl-vision-ocr-summary'
      ? '两阶段图像综合分析：第一阶段进行高精度视觉主体理解、艺术排版与风格解析及OCR提取，第二阶段由语言模型进行结构化梳理与润色'
      : r.desc_zh,
    desc_en: r.template_id === 'tpl-vision-ocr-summary'
      ? 'Two-stage visual analysis pipeline: high-precision visual understanding, style/layout analysis, and OCR extraction followed by structured synthesis'
      : r.desc_en,
    head_modalities: safeJsonParse<string[]>(r.head_modalities, []),
    tail_modalities: safeJsonParse<string[]>(r.tail_modalities, []),
    roles: safeJsonParse<DAGRole[]>(r.roles, []),
    priority: r.priority || 1,
    status: r.status || 'active'
  }));

  const rawModels = await env.DB.prepare(
    "SELECT * FROM models WHERE status = 'active'"
  ).all<any>();

  const allModels: ModelMetadata[] = (rawModels.results || []).map(r => ({
    model_id: r.model_id,
    display_name: r.display_name,
    provider: r.provider,
    endpoint: r.endpoint,
    modalities: safeJsonParse<string[]>(r.modalities, []),
    tags: safeJsonParse<string[]>(r.tags, []),
    context_window: r.context_window || 4096,
    max_concurrency: r.max_concurrency || 50,
    active_connections: r.active_connections || 0,
    precision: r.precision || 0.8,
    user_rating: r.user_rating || 5.0,
    usage_count: r.usage_count || 0,
    cost_per_1k_tokens: r.cost_per_1k_tokens || 1.0,
    status: r.status,
    is_generalist: r.is_generalist || 0,
    prior_score: r.prior_score || 0.0,
    scenario_anchors: safeJsonParse<string[]>(r.scenario_anchors, []),
    anchor_embeddings: r.anchor_embeddings ? safeJsonParse<number[][] | null>(r.anchor_embeddings, null) : null,
    inference_target: r.inference_target || 'cloud',
    browser_runtime: r.browser_runtime || undefined,
    download_size_bytes: r.download_size_bytes || 0
  }));

  // Hard filter models
  const candidateModels = hardFilterModels(
    allModels, 
    envelope.metadata.estimated_input_tokens,
    !!options.disableBrowserInference
  );

  // Subsistence Law (温饱定律) for templates
  const subsistenceTemplates = filterTemplatesBySubsistence(allTemplates, userModalities);
  if (subsistenceTemplates.length === 0) {
    throw new Error(`当前没有适合处理 [${userModalities.join(', ')}] 输入模态的可用模板。`);
  }

  // ----------------------------------------------------
  // Step 2: Template Selection (Skip scoring if already chosen)
  // ----------------------------------------------------
  let selectedTemplate: DAGTemplate;
  let candidateTop3: DAGTemplate[] = [];

  if (options.reRouteMode === 'switch_template' && options.chosenTemplateId) {
    // Case 1: Template ALREADY selected by user from Top 2 / Top 3 pool!
    // Skip Step 2 LLM candidate ranking. Directly lock chosen template!
    const found = subsistenceTemplates.find(t => t.template_id === options.chosenTemplateId)
      || allTemplates.find(t => t.template_id === options.chosenTemplateId);
    if (!found) {
      throw new Error(`指定的模板 [${options.chosenTemplateId}] 不存在或不可用`);
    }
    selectedTemplate = found;
    candidateTop3 = [selectedTemplate, ...subsistenceTemplates.filter(t => t.template_id !== selectedTemplate.template_id)].slice(0, 3);
  } else if (options.reRouteMode === 'switch_model' && options.chosenTemplateId) {
    // Case 2: Template ALREADY fixed by user!
    // Skip Step 2 LLM candidate ranking. Directly lock current template!
    const found = allTemplates.find(t => t.template_id === options.chosenTemplateId) || subsistenceTemplates[0];
    selectedTemplate = found;
    candidateTop3 = [selectedTemplate, ...subsistenceTemplates.filter(t => t.template_id !== selectedTemplate.template_id)].slice(0, 3);
  } else {
    // Normal Case & Case 3: Rank candidate templates with JEV
    candidateTop3 = await rankCandidateTemplates(env, subsistenceTemplates, envelope.instruction_payload, userModalities);
    selectedTemplate = candidateTop3[0];

    if (selectedTemplate.template_id === SENTINEL_UNREACHABLE_TEMPLATE_ID) {
      const unreachableRole: DAGRole = {
        role_id: 'role_unreachable',
        name_zh: '∅ 意图不可达',
        name_en: '∅ Unreachable',
        in_modalities: ['text'],
        out_modalities: ['text'],
        in_degree: 0,
        out_degree: 0,
        requisition_tags: ['unreachable']
      };

      const unreachableModel: ModelMetadata = {
        model_id: 'model_unreachable',
        display_name: 'Unreachable',
        provider: 'NanoMesh Gateway',
        endpoint: '',
        modalities: ['text'],
        tags: ['unreachable'],
        context_window: 0,
        max_concurrency: 0,
        active_connections: 0,
        precision: 0,
        user_rating: 0,
        usage_count: 0,
        cost_per_1k_tokens: 0,
        status: 'unreachable',
        is_generalist: 0,
        prior_score: 0,
        scenario_anchors: []
      };

      return {
        template: SENTINEL_UNREACHABLE_TEMPLATE,
        candidate_templates: [],
        nodes: [{
          role: unreachableRole,
          selected_model: unreachableModel,
          standby_models: [],
          score_details: {
            model: unreachableModel,
            score: 0,
            sim: 0,
            concurrency_penalty: 0,
            specialist_score: 0
          },
          downgraded: false,
          claimed_assets: []
        }],
        reasoning_trace: {
          intent_state: isReRoute ? null : intentState,
          target_branch_id: isReRoute ? undefined : targetBranchId,
          is_multi_round: !isReRoute && !!intentState,
          subsistence_filtered_count: subsistenceTemplates.length,
          selected_template_id: SENTINEL_UNREACHABLE_TEMPLATE_ID,
          downgrade_events: []
        },
        is_unreachable: true
      };
    }
  }

  // ----------------------------------------------------
  // Step 3: Model Resolution & Instantiation (Skip scoring if switch_model)
  // ----------------------------------------------------
  const instantiatedNodes: InstantiatedDAGNode[] = [];
  const downgradeEvents: Array<{ role_id: string; original_tag: string; fallback_tag: string }> = [];

  if (options.reRouteMode === 'switch_model') {
    // Case 2: Models and/or prompts ALREADY selected by user!
    // Skip Step 3 Prompt Embedding and heavy scoring formulas! Directly instantiate nodes for Step 4.
    for (const role of selectedTemplate.roles) {
      const roleResolution = resolveRoleCompetence(role, candidateModels);
      if (roleResolution.downgradeEvent) {
        downgradeEvents.push({ role_id: role.role_id, ...roleResolution.downgradeEvent });
      }

      let primaryModel: ModelMetadata;
      if (options.chosenRoleModels && options.chosenRoleModels[role.role_id]) {
        const customModel = candidateModels.find(m => m.model_id === options.chosenRoleModels![role.role_id]);
        primaryModel = customModel || roleResolution.selectedModels[0];
      } else {
        primaryModel = roleResolution.selectedModels[0];
      }

      const standbyModels = roleResolution.selectedModels
        .filter(m => m.model_id !== primaryModel.model_id)
        .slice(0, 6);

      const nodeCustomPrompt = (options.customRolePrompts && options.customRolePrompts[role.role_id] !== undefined)
        ? options.customRolePrompts[role.role_id]
        : '';

      instantiatedNodes.push({
        role,
        selected_model: primaryModel,
        standby_models: standbyModels,
        score_details: {
          model: primaryModel,
          score: 1.0,
          sim: 1.0,
          concurrency_penalty: 0,
          specialist_score: 1.0
        },
        downgraded: roleResolution.downgraded,
        compensation_prompt: roleResolution.compensationPrompt,
        custom_prompt: nodeCustomPrompt,
        claimed_assets: []
      });
    }
  } else {
    // Case 1 & Normal case: Run full Vector Embeddings (bge-m3) & Ultimate Scoring Formula
    const promptEmbedding = await generatePromptEmbedding(env, envelope.instruction_payload);

    for (const role of selectedTemplate.roles) {
      const roleResolution = resolveRoleCompetence(role, candidateModels);
      if (roleResolution.downgradeEvent) {
        downgradeEvents.push({ role_id: role.role_id, ...roleResolution.downgradeEvent });
      }

      const scoredModels = await scoreAndRankRoleModels(
        env,
        roleResolution.selectedModels,
        promptEmbedding,
        envelope.instruction_payload
      );

      if (scoredModels.length === 0) {
        throw new Error(`岗位 [${role.name_zh}] 未能选出可用模型。`);
      }

      let primaryModel = scoredModels[0].model;
      if (options.chosenRoleModels && options.chosenRoleModels[role.role_id]) {
        const customModelMatch = roleResolution.selectedModels.find(
          m => m.model_id === options.chosenRoleModels![role.role_id]
        );
        if (customModelMatch) {
          primaryModel = customModelMatch;
        }
      }

      const standbyModels = scoredModels
        .map(sm => sm.model)
        .filter(m => m.model_id !== primaryModel.model_id)
        .slice(0, 6);

      const nodeCustomPrompt = (options.customRolePrompts && options.customRolePrompts[role.role_id] !== undefined)
        ? options.customRolePrompts[role.role_id]
        : (options.customNodePrompt && !options.customRolePrompts ? options.customNodePrompt : '');

      instantiatedNodes.push({
        role,
        selected_model: primaryModel,
        standby_models: standbyModels,
        score_details: scoredModels[0],
        downgraded: roleResolution.downgraded,
        compensation_prompt: roleResolution.compensationPrompt,
        custom_prompt: nodeCustomPrompt,
        claimed_assets: []
      });
    }
  }

  return {
    template: selectedTemplate,
    candidate_templates: candidateTop3,
    nodes: instantiatedNodes,
    reasoning_trace: {
      intent_state: isReRoute ? null : intentState,
      target_branch_id: isReRoute ? undefined : targetBranchId,
      is_multi_round: !isReRoute && !!options.hasPreviousRound,
      subsistence_filtered_count: subsistenceTemplates.length,
      selected_template_id: selectedTemplate.template_id,
      downgrade_events: downgradeEvents
    }
  };
}
