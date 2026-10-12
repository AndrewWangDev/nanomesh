-- Migration: 0010_real_models_and_templates.sql
-- Real Cloudflare Workers AI models, role-tag requisition catalog, and DAG templates
-- Purge poisoned cache entries and align all model IDs to 100% verified Workers AI models.

-- 1. Purge legacy poisoned cache rows
DELETE FROM dag_execution_cache WHERE output_text LIKE '%已基于输入完成%';

-- 2. Retire legacy placeholder models
UPDATE models SET status = 'inactive' WHERE model_id IN ('model-qwen2-vl-7b', 'model-deepseek-r1', 'model-llama3-01', 'model-qwen3-01', 'model-whisper-01');

-- 3. Insert real verified Cloudflare Workers AI models
INSERT OR REPLACE INTO models (model_id, display_name, provider, endpoint, modalities, tags, context_window, max_concurrency, active_connections, precision, user_rating, usage_count, cost_per_1k_tokens, status, is_generalist, prior_score, scenario_anchors)
VALUES
(
    'cf-llava-1.5-7b',
    'LLaVA-1.5 视觉专才',
    'Cloudflare/LF',
    '@cf/llava-hf/llava-1.5-7b-hf',
    '["image","text"]',
    '["#ocr_precise","#multimodal_vision","#general_vlm"]',
    4096,
    50,
    2,
    0.95,
    4.95,
    1500,
    1.2,
    'active',
    0,
    0.0,
    '["海报文字提取与OCR识别","单据表格抽取","高分辨率图像细节分析"]'
),
(
    'cf-moondream-9b',
    'Moondream-3.1 敏捷视觉',
    'Moondream',
    '@cf/moondream/moondream3.1-9B-A2B',
    '["image","text"]',
    '["#multimodal_vision","#general_vlm"]',
    4096,
    60,
    1,
    0.90,
    4.75,
    890,
    0.8,
    'active',
    0,
    0.0,
    '["画面主体描述","视觉问答","轻量图像理解"]'
),
(
    'cf-qwq-32b',
    'QwQ-32B 深度推理',
    'Qwen',
    '@cf/qwen/qwq-32b',
    '["text"]',
    '["#reasoning","#analysis","#structuring"]',
    24000,
    40,
    4,
    0.98,
    4.98,
    2300,
    2.0,
    'active',
    0,
    0.0,
    '["复杂逻辑链条推演","财务研报深度归因分析","结构化深度梳理"]'
),
(
    'cf-llama-3.1-8b',
    'Llama-3.1 表达润色',
    'Meta',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
    '["text"]',
    '["#text_generation","#creative_writing","#analysis"]',
    131000,
    80,
    6,
    0.95,
    4.88,
    4100,
    1.0,
    'active',
    0,
    0.0,
    '["商业文案地道翻译","文字润色与正式风格改写","内容扩写精炼"]'
),
(
    'cf-qwen2.5-coder',
    'Qwen2.5-Coder 严密分析',
    'Qwen',
    '@cf/qwen/qwen2.5-coder-32b-instruct',
    '["text"]',
    '["#analysis","#code","#structuring"]',
    32768,
    50,
    3,
    0.96,
    4.85,
    1800,
    1.5,
    'active',
    0,
    0.0,
    '["Markdown表格精准规整","数据字段清洗提取","技术报告排版"]'
),
(
    'cf-llama-3.2-3b',
    'Llama-3.2 极速对话',
    'Meta',
    '@cf/meta/llama-3.2-3b-instruct',
    '["text"]',
    '["#chat","#fast","#general"]',
    131000,
    100,
    8,
    0.90,
    4.65,
    6200,
    0.5,
    'active',
    1,
    0.25,
    '["日常即时对话","简明概念解答","高并发快答"]'
),
(
    'cf-whisper',
    'Whisper 语音听写',
    'OpenAI',
    '@cf/openai/whisper',
    '["audio"]',
    '["#asr","#audio_processing"]',
    4096,
    30,
    2,
    0.96,
    4.90,
    3100,
    1.5,
    'active',
    0,
    0.0,
    '["会议语音转文字","多语种录音听写","口语化语音转纯净文本"]'
);

-- 4. Seed accurate DAG templates with complete role-tag contracts
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
    '视觉多模态全景分析',
    'Multimodal Vision Analysis',
    '两阶段图像综合分析：第一阶段进行高精度视觉主体理解、艺术排版与风格解析及OCR提取，第二阶段由语言模型进行结构化梳理与润色',
    'Two-stage visual analysis pipeline: high-precision visual understanding, style/layout analysis, and OCR extraction followed by structured synthesis',
    '["image"]',
    '["text"]',
    '[{"role_id":"role-vision-extractor","name_zh":"视觉元素与文字提取","name_en":"Vision & OCR Extraction","in_modalities":["image"],"out_modalities":["text"],"in_degree":0,"out_degree":1,"requisition_tags":["#ocr_precise","#multimodal_vision","#general_vlm"],"compensation_prompts":{"#multimodal_vision":"【系统约束】你当前扮演高精度OCR识别专家，请忽略背景无关干扰，逐字逐行输出图片中识别出的所有可见文字与排版结构。","#general_vlm":"【系统约束】请尽可能详细地提取并描述图片内的文字、表格以及核心视觉数据。"}},{"role_id":"role-synthesis-polish","name_zh":"结构化分析与润色","name_en":"Structuring & Refinement","in_modalities":["text"],"out_modalities":["text"],"in_degree":1,"out_degree":0,"requisition_tags":["#reasoning","#analysis","#text_generation"],"compensation_prompts":{"#text_generation":"【系统约束】请根据上游提取的文档文字信息，结合用户意图进行结构化整理和润色输出。"}}]' ,
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
    '[{"role_id":"role-audio-asr","name_zh":"语音转录提取","name_en":"Speech Recognition","in_modalities":["audio"],"out_modalities":["text"],"in_degree":0,"out_degree":1,"requisition_tags":["#asr","#audio_processing"],"compensation_prompts":{"#audio_processing":"【系统约束】请精准转写音频流内容为自然文本，过滤杂音。"}},{"role_id":"role-action-extractor","name_zh":"行动项总结与决策","name_en":"Action Items Extractor","in_modalities":["text"],"out_modalities":["text"],"in_degree":1,"out_degree":0,"requisition_tags":["#reasoning","#analysis","#text_generation"],"compensation_prompts":{"#text_generation":"【系统约束】请根据会议或录音转写内容，提炼出清晰的关键行动项和结论。"}}]' ,
    15,
    'active'
);
