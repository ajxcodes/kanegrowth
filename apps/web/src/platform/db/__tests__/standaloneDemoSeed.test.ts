import { describe, expect, it } from 'vitest'
import { MemorySqliteDriver } from '@platform/db/MemorySqliteDriver'
import { runMigrations } from '@platform/db/migrations/runMigrations'
import { MIGRATIONS } from '@platform/db/migrations/schema'
import {
  ensureStandaloneDemoSeed,
  readDemoSeedState,
  seedAnalyticsHouseholdFixture,
} from '@platform/db/repositories/analyticsSeed'
import { SqliteStandaloneDemoDataAdapter } from '@adapters/demoData/SqliteStandaloneDemoDataAdapter'
import type { LocalDb } from '@platform/db/LocalDb'

const createMigratedDb = async (): Promise<LocalDb> => {
  const db = await MemorySqliteDriver.create()
  await runMigrations(db, MIGRATIONS)
  return db
}

const count = async (db: LocalDb, table: string): Promise<number> => {
  const rows = await db.select<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
  return rows[0]?.count ?? 0
}

const countWhere = async (db: LocalDb, table: string, where: string): Promise<number> => {
  const rows = await db.select<{ count: number }>(
    `SELECT count(*) AS count FROM ${table} WHERE ${where}`
  )
  return rows[0]?.count ?? 0
}

describe('standalone demo seed integration against MemorySqliteDriver', () => {
  it('first boot seeds the canonical demo dataset and records the seeded marker', async () => {
    const db = await createMigratedDb()
    try {
      const seeded = await ensureStandaloneDemoSeed(db)

      expect(seeded).toBe(true)
      expect(await count(db, 'accounts')).toBe(6)
      expect(await count(db, 'transactions')).toBe(62)
      expect(await count(db, 'categories')).toBe(9)
      expect(await count(db, 'tags')).toBe(3)
      expect(await count(db, 'household_members')).toBe(2)
      expect(await readDemoSeedState(db)).toBe('seeded')
      expect(await ensureStandaloneDemoSeed(db)).toBe(false)
      expect(await count(db, 'accounts')).toBe(6)
    } finally {
      await db.close()
    }
  })

  it('clear records the dismissed marker and a simulated reload does not re-seed', async () => {
    const db = await createMigratedDb()
    try {
      await seedAnalyticsHouseholdFixture(db)
      const adapter = new SqliteStandaloneDemoDataAdapter(db)

      expect(await adapter.clearDemoData()).toMatchObject({ status: 'empty', accountCount: 0 })
      expect(await ensureStandaloneDemoSeed(db)).toBe(false)
      expect(await count(db, 'accounts')).toBe(0)
      expect(await count(db, 'transactions')).toBe(0)
      expect(await readDemoSeedState(db)).toBe('dismissed')
    } finally {
      await db.close()
    }
  })

  it('reset restores the canonical demo dataset after clear', async () => {
    const db = await createMigratedDb()
    try {
      await seedAnalyticsHouseholdFixture(db)
      const adapter = new SqliteStandaloneDemoDataAdapter(db)
      await adapter.clearDemoData()

      expect((await adapter.resetToDemoData()).status).toBe('demo')
      expect(await count(db, 'accounts')).toBe(6)
      expect(await count(db, 'transactions')).toBe(62)
      expect(await readDemoSeedState(db)).toBe('seeded')
    } finally {
      await db.close()
    }
  })

  it('reset replaces user-created records with the canonical demo dataset', async () => {
    const db = await createMigratedDb()
    try {
      await db.exec(
        `INSERT INTO accounts
          (_id, userId, workspaceId, name, type, currency, currentBalance, isArchived, data,
           updatedAt, _localUpdatedAt)
         VALUES ('custom_acc', 'user_custom', 'ws_custom', 'Custom Checking', 'checking', 'USD',
                 1000, 0, '{}', '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z')`
      )
      const adapter = new SqliteStandaloneDemoDataAdapter(db)

      await adapter.resetToDemoData()

      expect(await countWhere(db, 'accounts', "_id = 'custom_acc'")).toBe(0)
      expect(await count(db, 'accounts')).toBe(6)
      expect(await count(db, 'transactions')).toBe(62)
    } finally {
      await db.close()
    }
  })

  it('adopting an existing pre-marker demo store does not duplicate rows', async () => {
    const db = await createMigratedDb()
    try {
      // A store seeded by the previous build has fixture rows but no `standaloneDemoSeed` marker.
      await seedAnalyticsHouseholdFixture(db)

      expect(await ensureStandaloneDemoSeed(db)).toBe(false)
      expect(await readDemoSeedState(db)).toBe('seeded')
      expect(await count(db, 'accounts')).toBe(6)
      expect(await count(db, 'transactions')).toBe(62)
    } finally {
      await db.close()
    }
  })
})
