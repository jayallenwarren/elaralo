-- SQLite schema for the Voice/Video companion capability mappings
CREATE TABLE IF NOT EXISTS companion_mappings (
  brand TEXT NOT NULL,
  avatar TEXT NOT NULL,
  eleven_voice_name TEXT,
  communication TEXT NOT NULL, -- "Audio" or "Video"
  eleven_voice_id TEXT,
  live TEXT, -- "D-ID" or "Stream" (only populated when communication="Video")
  did_embed_code TEXT,
  did_agent_link TEXT,
  did_agent_id TEXT,
  did_client_key TEXT,
  PRIMARY KEY (brand, avatar)
);
