CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  upstream_conversation_id TEXT,
  response_id TEXT,
  share_link_id TEXT,
  token TEXT,
  full_hash TEXT,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_expires_at ON conversations(expires_at);
CREATE INDEX IF NOT EXISTS idx_conversations_full_hash ON conversations(full_hash);
