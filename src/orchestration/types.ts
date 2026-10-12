// src/orchestration/types.ts

export type Modality = 'text' | 'image' | 'audio' | 'text_doc';

export interface AssetDescriptor {
  asset_id: string;
  modality: Modality;
  mime_type: string;
  file_size: number;
  r2_key?: string;            // e.g. tmp/... or assets/...
  in_memory_text?: string;    // Plain text / Markdown table extracted client-side
  in_memory_data?: string;    // Base64 data URL for images/multimodal assets
  consumed: boolean;          // Cursor: whether consumed by a DAG node
  source_digest: string;      // SHA-256 digest of content
  is_new?: boolean;           // Whether uploaded in the current round
  filename?: string;          // Original filename for display and receipt
}

export interface ConstraintContext {
  target_language: 'auto' | 'zh' | 'en';
  output_style: 'concise' | 'detailed' | 'creative';
}

export interface UnifiedProtocolEnvelope {
  envelope_id: string;
  session_id: string;
  round_index: number;
  instruction_payload: string;
  assets_manifest: AssetDescriptor[];
  constraint_context: ConstraintContext;
  metadata: {
    client_timestamp: number;
    char_count_total: number;
    estimated_input_tokens: number;
    has_new_upload?: boolean;
    new_upload_count?: number;
    new_upload_modalities?: string[];
  };
}

export interface DAGRole {
  role_id: string;
  name_zh: string;
  name_en: string;
  in_modalities: string[];
  out_modalities: string[];
  in_degree: number;
  out_degree: number;
  requisition_tags: string[];
  compensation_prompts?: Record<string, string>;
}

export interface DAGTemplate {
  template_id: string;
  name_zh: string;
  name_en: string;
  desc_zh: string;
  desc_en: string;
  head_modalities: string[];
  tail_modalities: string[];
  roles: DAGRole[];
  priority: number;
  status: string;
}

export interface ModelMetadata {
  model_id: string;
  display_name: string;
  provider: string;
  endpoint: string;
  modalities: string[];
  tags: string[];
  context_window: number;
  max_concurrency: number;
  active_connections: number;
  precision: number;
  user_rating: number;
  usage_count: number;
  cost_per_1k_tokens: number;
  status: string;
  is_generalist: number;
  prior_score: number;
  scenario_anchors: string[];
  anchor_embeddings?: number[][] | null;
  inference_target?: 'cloud' | 'browser';
  browser_runtime?: 'webgpu' | 'wasm';
  download_size_bytes?: number;
}

export interface ScoredModel {
  model: ModelMetadata;
  score: number;
  sim: number;
  concurrency_penalty: number;
  specialist_score: number;
}

export interface InstantiatedDAGNode {
  role: DAGRole;
  selected_model: ModelMetadata;
  standby_models: ModelMetadata[]; // Top 2 & Top 3 for user switching & failover
  score_details: ScoredModel;
  downgraded: boolean;
  compensation_prompt?: string;
  custom_prompt?: string;
  claimed_assets: AssetDescriptor[];
  upstream_output?: string;
  final_prompt?: string;
  cache_hit?: boolean;
}

export interface SessionAssetLedgerItem {
  asset_id: string;
  filename: string;
  modality: Modality;
  mime_type?: string;
  file_size?: number;
  introduced_round?: number;
  branch_id?: string;
}

export interface InstantiatedDAG {
  template: DAGTemplate;
  candidate_templates: DAGTemplate[]; // Top 3 candidate templates
  nodes: InstantiatedDAGNode[];
  reasoning_trace: {
    intent_state: 'ANCHOR_TAIL' | 'REBIND_ROOT' | 'CROSS_FUSION' | 'SWITCH_BRANCH' | 'DETACH_RESET' | null;
    target_branch_id?: string;
    is_multi_round: boolean;
    subsistence_filtered_count: number;
    selected_template_id: string;
    downgrade_events: Array<{ role_id: string; original_tag: string; fallback_tag: string }>;
  };
  is_security_violation?: boolean;
  is_unreachable?: boolean;
}

