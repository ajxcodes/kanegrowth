import { describe, expect, it } from 'vitest'
import { MemorySqliteDriver } from '@platform/db/MemorySqliteDriver'
import { runMigrations } from '@platform/db/migrations/runMigrations'
import { MIGRATIONS } from '@platform/db/migrations/schema'
import { seedAnalyticsHouseholdFixture } from '@platform/db/repositories/analyticsSeed'
import type { LocalDb } from '@platform/db/LocalDb'
import { SqliteStandaloneDemoDataAdapter } from '../SqliteStandaloneDemoDataAdapter'

const DEMO_DATA_TABLES = [
  'transaction_tags',
  'transactions',
  'accounts',
  'budgets',
  'savingsGoals',
  'savingsGoalContributions',
  'categories',
  'tags',
  'recurringRules',
  'categorizationRules',
  'transactionTemplates',
  'household_members',
  'saved_analytics_views',
  '_outbox',
  '_conflicts',
  '_blobs',
  '_receipt_uploads',
] as const

const createMigratedDb = async (): Promise<LocalDb> => {
  const db = await MemorySqliteDriver.create()
  await runMigrations(db, MIGRATIONS)
  return db
}

const count = async (db: LocalDb, table: string): Promise<number> => {
  const rows = await db.select<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
  return rows[0]?.count ?? 0
}

describe('SqliteStandaloneDemoDataAdapter integration against MemorySqliteDriver', () => {
  it('clearDemoData empties every household table and keeps the migration ledger', async () => {
    const db = await createMigratedDb()
    try {
      await seedAnalyticsHouseholdFixture(db)
      await db.exec(
        `INSERT INTO _outbox (opId, entity, operation, payload, createdAt)
         VALUES ('op_1', 'accounts', 'create', '{}', '2026-11-26T00:00:00.000Z')`
      )
      const adapter = new SqliteStandaloneDemoDataAdapter(db)

      await adapter.clearDemoData()

      for (const table of DEMO_DATA_TABLES) {
        expect(await count(db, table)).toBe(0)
      }
      expect(await count(db, '_schema_version')).toBe(1)
    } finally {
      await db.close()
    }
  })

  it('resetToDemoData is idempotent and never duplicates fixture rows', async () => {
    const db = await createMigratedDb()
    try {
      const adapter = new SqliteStandaloneDemoDataAdapter(db)

      expect((await adapter.resetToDemoData()).status).toBe('demo')
      expect((await adapter.resetToDemoData()).accountCount).toBe(6)
      expect(await count(db, 'accounts')).toBe(6)
      expect(await count(db, 'transactions')).toBe(62)
    } finally {
      await db.close()
    }
  })

  // TR-43e
  it('clearDemoData also wipes envelopeAssignments', async () => {
    const db = await createMigratedDb()
    try {
      await db.exec(
        `INSERT INTO envelopeAssignments (_id, userId, workspaceId, kind, envelopeId, month, amountMinor, data, updatedAt, _localUpdatedAt, _dirty, _syncState)
         VALUES ('ea1', 'u1', NULL, 'assignment', 'food', '2027-01', 5000, '{}', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 0, 'synced')`
      )
      expect(await count(db, 'envelopeAssignments')).toBe(1)
      const adapter = new SqliteStandaloneDemoDataAdapter(db)
      await adapter.clearDemoData()
      expect(await count(db, 'envelopeAssignments')).toBe(0) // DEMO_DATA_TABLES includes 'envelopeAssignments'
      expect(await count(db, '_schema_version')).toBe(1) // migration ledger retained
    } finally {
      await db.close()
    }
  })
})
