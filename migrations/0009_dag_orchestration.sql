-- Migration: 0009_dag_orchestration.sql
-- Gateway orchestration tables: DAG templates, deterministic cache, and model anchor extensions.

CREATE TABLE IF NOT EXISTS dag_templates (
    template_id      TEXT PRIMARY KEY,
    name_zh          TEXT NOT NULL,
    name_en          TEXT NOT NULL,
    desc_zh          TEXT NOT NULL,
    desc_en          TEXT NOT NULL,
    head_modalities  TEXT NOT NULL, -- JSON array e.g. ["text"] or ["image"] or ["audio"]
    tail_modalities  TEXT NOT NULL, -- JSON array e.g. ["text"]
    roles            TEXT NOT NULL, -- JSON array of DAG role definitions
    priority         INTEGER DEFAULT 1,
    status           TEXT DEFAULT 'active',
    created_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dag_templates_status ON dag_templates(status);

CREATE TABLE IF NOT EXISTS dag_execution_cache (
    cache_key        TEXT PRIMARY KEY, -- SHA256(role_id + model_id + input_digest + injected_prompt)
    role_id          TEXT NOT NULL,
    model_id         TEXT NOT NULL,
    input_digest     TEXT NOT NULL,
    injected_prompt  TEXT NOT NULL,
    output_text      TEXT NOT NULL,
    created_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dag_cache_created ON dag_execution_cache(created_at);

-- Add anchor and generalist columns to models table
ALTER TABLE models ADD COLUMN is_generalist INTEGER DEFAULT 0;
ALTER TABLE models ADD COLUMN prior_score REAL DEFAULT 0.0;
ALTER TABLE models ADD COLUMN scenario_anchors TEXT DEFAULT '[]';
ALTER TABLE models ADD COLUMN anchor_embeddings TEXT DEFAULT NULL;

-- Seed default DAG templates
INSERT OR REPLACE INTO dag_templates (template_id, name_zh, name_en, desc_zh, desc_en, head_modalities, tail_modalities, roles, priority, status)
VALUES 
(
    'tpl-direct-chat',
    '全能直答',
    'Direct Inference',
    '单节点高敏捷响应，适合日常问答、创作与即时咨询',
    'Single-node direct response for chat, general inquiries, and content generation',
    '["text"]',
    '["text"]',
    '[{"role_id":"role-direct-chat","name_zh":"综合理解与生成","name_en":"General Synthesis","in_modalities":["text"],"out_modalities":["text"],"in_degree":0,"out_degree":0,"requisition_tags":["#chat","#text_generation","#general"],"compensation_prompts":{"#general":"【系统约束】你是一个专业的AI助手，请直接全面回答用户的问题。"}}]' ,
    10,
    'active'
),
(
    'tpl-vision-ocr-summary',
    '视觉文档研报抽取',
    'Vision Document Pipeline',
    '两阶段精细化提取，先进行高精度视觉/OCR解析，再由语言模型结构化提炼',
    'Two-stage pipeline: High-precision Vision OCR extraction followed by structured linguistic synthesis',
    '["image"]',
    '["text"]',
    '[{"role_id":"role-vision-extractor","name_zh":"视觉元素与文字提取","name_en":"Vision & OCR Extraction","in_modalities":["image"],"out_modalities":["text"],"in_degree":0,"out_degree":1,"requisition_tags":["#ocr_precise","#multimodal_vision","#general_vlm"],"compensation_prompts":{"#multimodal_vision":"【系统约束】你当前扮演高精度OCR识别专家，请忽略背景无关干扰，逐字逐行输出图片中识别出的所有可见文字与排版结构。","#general_vlm":"【系统约束】请尽可能详细地提取并描述图片内的文字、表格以及核心视觉数据。"}},{"role_id":"role-synthesis-polish","name_zh":"结构化分析与润色","name_en":"Structuring & Refinement","in_modalities":["text"],"out_modalities":["text"],"in_degree":1,"out_degree":0,"requisition_tags":["#analysis","#text_generation","#creative_writing"],"compensation_prompts":{"#text_generation":"【系统约束】请根据上游提取的文档文字信息，结合用户意图进行结构化整理和润色输出。"}}]' ,
    20,
    'active'
),
(
    'tpl-audio-action-items',
    '语音行动项提炼',
    'Audio Action Pipeline',
    '音频高灵敏听写转录 + 核心行动项归纳决策',
    'Speech recognition transcription followed by core action items distillation',
    '["audio"]',
    '["text"]',
    '[{"role_id":"role-audio-asr","name_zh":"语音转录提取","name_en":"Speech Recognition","in_modalities":["audio"],"out_modalities":["text"],"in_degree":0,"out_degree":1,"requisition_tags":["#asr","#audio_processing"],"compensation_prompts":{"#audio_processing":"【系统约束】请精准转写音频流内容为自然文本，过滤杂音。"}},{"role_id":"role-action-extractor","name_zh":"行动项总结与决策","name_en":"Action Items Extractor","in_modalities":["text"],"out_modalities":["text"],"in_degree":1,"out_degree":0,"requisition_tags":["#summarization","#text_generation","#analysis"],"compensation_prompts":{"#text_generation":"【系统约束】请根据会议或录音转写内容，提炼出清晰的关键行动项和结论。"}}]' ,
    15,
    'active'
),
(
    'tpl-multimodal-fusion',
    '多模态全景分析',
    'Multimodal Fusion',
    '支持图文并举的综合全链路协同流水线',
    'End-to-end multimodal pipeline supporting joint visual and text analysis',
    '["image","text"]',
    '["text"]',
    '[{"role_id":"role-vision-vlm","name_zh":"视觉信息深度解析","name_en":"Vision Deep Analysis","in_modalities":["image"],"out_modalities":["text"],"in_degree":0,"out_degree":1,"requisition_tags":["#multimodal_vision","#ocr_precise","#general_vlm"],"compensation_prompts":{"#ocr_precise":"【系统约束】你当前承接多模态视觉深度解析职责，请在识别可见文字的同时，提炼整体画面的视觉语义与布局关系。","#general_vlm":"【系统约束】请对图像进行全景式深度分析，逐一解析画面中的核心主体、数据图表及文本细节。"}},{"role_id":"role-multimodal-synthesis","name_zh":"多源融合总览","name_en":"Multimodal Synthesis","in_modalities":["text"],"out_modalities":["text"],"in_degree":1,"out_degree":0,"requisition_tags":["#analysis","#text_generation"],"compensation_prompts":{"#text_generation":"【系统约束】请综合分析上游提取的图文多模态特征，结合用户核心诉求进行深度归纳总结与全景呈现。"}}]' ,
    25,
    'active'
);

-- Seed / update models with anchors and generalist priors
INSERT OR REPLACE INTO models (model_id, display_name, provider, endpoint, modalities, tags, context_window, max_concurrency, active_connections, precision, user_rating, usage_count, cost_per_1k_tokens, status, is_generalist, prior_score, scenario_anchors)
VALUES
(
    'model-qwen2-vl-7b',
    'Qwen2-VL 视觉专才',
    'Alibaba Cloud',
    'https://ai.andrewwangdev.com/v1/models/qwen2-vl',
    '["image","text"]',
    '["#ocr_precise","#multimodal_vision","#general_vlm"]',
    8192,
    50,
    3,
    0.95,
    4.9,
    1240,
    1.5,
    'active',
    0,
    0.0,
    '["海报文字提取与OCR识别","发票单据表格结构化抽取","高分辨率图像细节分析与视觉问答"]'
),
(
    'model-deepseek-r1',
    'DeepSeek-R1 深度推理',
    'DeepSeek',
    'https://ai.andrewwangdev.com/v1/models/deepseek-r1',
    '["text"]',
    '["#analysis","#reasoning","#text_generation"]',
    16384,
    40,
    8,
    0.98,
    4.95,
    2800,
    2.0,
    'active',
    0,
    0.0,
    '["复杂逻辑链条推演","财务研报深度归因分析","算法与架构严密设计"]'
);

UPDATE models 
SET is_generalist = 0, prior_score = 0.0, scenario_anchors = '["多语种音频会议记录","语音对话听写转录","口语化语音转纯净文本"]'
WHERE model_id = 'model-whisper-01';

UPDATE models 
SET is_generalist = 1, prior_score = 0.25, scenario_anchors = '["中英日韩多语言精准翻译","跨语种内容润色","通用结构化报告总结"]'
WHERE model_id = 'model-qwen3-01';

UPDATE models 
SET is_generalist = 1, prior_score = 0.25, scenario_anchors = '["创意文案写作与扩写","头脑风暴日常会话","文风转换与文学表达"]'
WHERE model_id = 'model-llama3-01';
