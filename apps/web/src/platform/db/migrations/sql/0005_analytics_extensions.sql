-- Migration 0005: KaneGrowth Analytics Schema Extensions
-- Adds household members, saved analytics views, normalized transaction tags,
-- promoted analytics columns on accounts/categories/transactions, and composite indexes.

CREATE TABLE IF NOT EXISTS household_members (
  _id TEXT PRIMARY KEY,
  workspaceId TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  color TEXT NOT NULL DEFAULT '#6366f1',
  isArchived INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_household_members_workspace ON household_members (workspaceId, deletedAt, name);

CREATE TABLE IF NOT EXISTS saved_analytics_views (
  _id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  workspaceId TEXT,
  name TEXT NOT NULL,
  chartTab TEXT NOT NULL DEFAULT 'sankey',
  filterJson TEXT NOT NULL,
  isPinned INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_saved_analytics_views_ws_updated ON saved_analytics_views (workspaceId, deletedAt, updatedAt);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transactionId TEXT NOT NULL,
  tagId TEXT NOT NULL,
  PRIMARY KEY (transactionId, tagId)
);
CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag_tx ON transaction_tags (tagId, transactionId);

-- Promoted analytics columns on accounts
ALTER TABLE accounts ADD COLUMN accountGroup TEXT NOT NULL DEFAULT 'banking';
ALTER TABLE accounts ADD COLUMN isLiability INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN interestRateBps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN minimumPaymentMinor INTEGER NOT NULL DEFAULT 0;

-- Promoted analytics columns on categories
ALTER TABLE categories ADD COLUMN envelopeType TEXT NOT NULL DEFAULT 'expense';
ALTER TABLE categories ADD COLUMN monthlyTargetMinor INTEGER NOT NULL DEFAULT 0;

-- Promoted analytics columns on transactions
ALTER TABLE transactions ADD COLUMN memberId TEXT;
ALTER TABLE transactions ADD COLUMN isShared INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transactions ADD COLUMN transferPairId TEXT;
ALTER TABLE transactions ADD COLUMN hasSplitChildren INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN splitTransactionId TEXT;
ALTER TABLE transactions ADD COLUMN tagsJson TEXT NOT NULL DEFAULT '[]';

-- Composite analytics indexes on transactions
CREATE INDEX IF NOT EXISTS idx_tx_analytics_ws_date ON transactions (workspaceId, deletedAt, status, date, type);
CREATE INDEX IF NOT EXISTS idx_tx_analytics_acct_cat_date ON transactions (accountId, categoryId, date);
CREATE INDEX IF NOT EXISTS idx_tx_analytics_member_shared_date ON transactions (memberId, isShared, date);
CREATE INDEX IF NOT EXISTS idx_tx_analytics_transfer_split ON transactions (transferPairId, hasSplitChildren);
