-- Add column for storing LLM vision analysis of generated clip frames
ALTER TABLE clip_nodes ADD COLUMN IF NOT EXISTS video_analysis_text TEXT;
