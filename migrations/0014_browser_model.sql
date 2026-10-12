-- Migration: 0014_browser_model.sql
-- Add inference_target, browser_runtime, and download_size_bytes to models table
-- Register first in-browser pioneer model: SmolLM2-135M-Instruct

ALTER TABLE models ADD COLUMN inference_target TEXT DEFAULT 'cloud';
ALTER TABLE models ADD COLUMN browser_runtime TEXT DEFAULT NULL;
ALTER TABLE models ADD COLUMN download_size_bytes INTEGER DEFAULT 0;

INSERT OR REPLACE INTO models (
    model_id, display_name, provider, endpoint, modalities, tags, context_window, max_concurrency, active_connections, precision, user_rating, usage_count, cost_per_1k_tokens, status, is_generalist, prior_score, scenario_anchors, inference_target, browser_runtime, download_size_bytes
) VALUES (
    'browser-smollm2-135m',
    'SmolLM2-135M 本地极速',
    'In-Browser (WebGPU)',
    'onnx-community/SmolLM2-135M-Instruct-ONNX-GQA',
    '["text"]',
    '["#chat","#fast","#general","#text_generation"]',
    2048,
    10,
    0,
    0.88,
    4.80,
    100,
    0.0,
    'active',
    1,
    0.0,
    '["日常即时对话","简明概念解答","高并发快答","本地离线极速"]',
    'browser',
    'webgpu',
    82000000
);
