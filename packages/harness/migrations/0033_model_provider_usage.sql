ALTER TABLE model_calls ADD COLUMN provider_input_tokens INTEGER;
ALTER TABLE model_calls ADD COLUMN provider_output_tokens INTEGER;
ALTER TABLE model_calls ADD COLUMN provider_total_tokens INTEGER;
