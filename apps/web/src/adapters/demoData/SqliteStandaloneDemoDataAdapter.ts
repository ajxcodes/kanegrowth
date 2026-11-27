import { deriveStandaloneDemoStatus } from '@domain/standaloneDemo'
import type { LocalDb } from '@platform/db/LocalDb'
import {
  insertHouseholdFixture,
  readDemoSeedState,
  writeDemoSeedState,
} from '@platform/db/repositories/analyticsSeed'
import type {
  StandaloneDemoDataPort,
  StandaloneDemoDataSnapshot,
} from '@ports/demoData/StandaloneDemoDataPort'
import { tableInvalidationBus } from '@lib/tableInvalidationBus'

/**
 * Order matters only for future foreign-key enforcement; today SQLite deletes are unconstrained.
 * Preferences (`_sync_meta`), the schema ledger (`_schema_version`) and owner/checkpoint metadata
 * are deliberately absent: clear/reset wipes household records, not device configuration.
 */
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

/**
 * SQLite-backed implementation of the standalone demo data port. All mutations run in a single
 * transaction so a failed seed leaves the previous workspace untouched; the UI never issues SQL.
 */
export class SqliteStandaloneDemoDataAdapter implements StandaloneDemoDataPort {
  constructor(private readonly db: LocalDb) {}

  async readSnapshot(): Promise<StandaloneDemoDataSnapshot> {
    const rows = await this.db.select<{ accountCount: number; transactionCount: number }>(
      `SELECT
         (SELECT count(*) FROM accounts WHERE deletedAt IS NULL) AS accountCount,
         (SELECT count(*) FROM transactions WHERE deletedAt IS NULL) AS transactionCount`
    )
    const accountCount = rows[0]?.accountCount ?? 0
    const transactionCount = rows[0]?.transactionCount ?? 0
    const seedState = await readDemoSeedState(this.db)
    return {
      status: deriveStandaloneDemoStatus(seedState, accountCount),
      seedState,
      accountCount,
      transactionCount,
    }
  }

  async clearDemoData(): Promise<StandaloneDemoDataSnapshot> {
    await this.db.transaction(async (tx) => {
      await this.wipeHouseholdTables(tx)
      await writeDemoSeedState(tx, 'dismissed')
    })
    this.publishInvalidations()
    return this.readSnapshot()
  }

  async resetToDemoData(): Promise<StandaloneDemoDataSnapshot> {
    await this.db.transaction(async (tx) => {
      await this.wipeHouseholdTables(tx)
      await insertHouseholdFixture(tx)
      await writeDemoSeedState(tx, 'seeded')
    })
    this.publishInvalidations()
    return this.readSnapshot()
  }

  private async wipeHouseholdTables(tx: LocalDb): Promise<void> {
    for (const table of DEMO_DATA_TABLES) {
      await tx.exec(`DELETE FROM ${table}`)
    }
  }

  private publishInvalidations(): void {
    for (const table of DEMO_DATA_TABLES) {
      tableInvalidationBus.publish(table)
    }
  }
}
