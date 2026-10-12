-- Fix tags JSON formatting for cf-moondream-9b and cf-llama-3.1-8b
UPDATE models 
SET tags = '["#ocr_precise", "#multimodal_vision", "#general_vlm"]',
    user_rating = 4.96
WHERE model_id = 'cf-moondream-9b';

UPDATE models 
SET tags = '["#reasoning", "#analysis", "#text_generation", "#structuring"]',
    user_rating = 4.96
WHERE model_id = 'cf-llama-3.1-8b';

UPDATE models 
SET user_rating = 4.82
WHERE model_id = 'cf-llava-1.5-7b';

UPDATE models 
SET user_rating = 4.90
WHERE model_id = 'cf-qwq-32b';
