-- Server-owned in-app notifications (issue #16).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  read_at TEXT,
  dismissed_at TEXT,
  ntfy_status TEXT NOT NULL DEFAULT 'skipped',
  ntfy_error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
-- Not partial: SQLite treats NULLs as distinct in a unique index, so rows without a
-- dedupe key never conflict, and `ON CONFLICT(user_id, dedupe_key)` can target this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe
  ON notifications (user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, dismissed_at, read_at);
