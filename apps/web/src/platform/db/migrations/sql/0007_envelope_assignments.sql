-- Migration 0007: Envelope / zero-based budgeting.
--
-- New syncable ledger entity `envelopeAssignment` / `envelopeAssignments`, offline-first, queued
-- through the existing sync engine exactly like other ledger entities. Additive
-- `CREATE TABLE IF NOT EXISTS` + indexes; no data rewrite; existing `_schema_version`/`user_version`
-- upgrades in place. `kind='assignment'` unique per (workspaceId, envelopeId, month);
-- `kind='monthClose'` unique per (workspaceId, month); `amountMinor` integer minor; `month='YYYY-MM'`.
-- Shared with `crates/kanegrowth-api` `MIGRATION_0007` (`include_str!`).

CREATE TABLE IF NOT EXISTS envelopeAssignments (
  _id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  workspaceId TEXT,
  kind TEXT NOT NULL DEFAULT 'assignment',         -- 'assignment' | 'monthClose'
  envelopeId TEXT NOT NULL DEFAULT '',
  month TEXT NOT NULL,                              -- 'YYYY-MM'
  amountMinor INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT,
  _localUpdatedAt TEXT NOT NULL,
  _dirty INTEGER NOT NULL DEFAULT 0,
  _syncState TEXT NOT NULL DEFAULT 'synced'
);
CREATE INDEX IF NOT EXISTS idx_envelopeAssignments_ws_month ON envelopeAssignments (workspaceId, month, deletedAt);
CREATE INDEX IF NOT EXISTS idx_envelopeAssignments_envelope_month ON envelopeAssignments (envelopeId, month, deletedAt);
CREATE INDEX IF NOT EXISTS idx_envelopeAssignments_user_updated ON envelopeAssignments (userId, updatedAt, _id);
