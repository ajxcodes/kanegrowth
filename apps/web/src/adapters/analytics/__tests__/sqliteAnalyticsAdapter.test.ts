import { describe, expect, it } from 'vitest'
import { createDefaultAnalyticsFilter } from '@domain/analytics/analyticsFilter'
import type { SavedAnalyticsView } from '@domain/analytics/types'
import { MemorySqliteDriver } from '@platform/db/MemorySqliteDriver'
import { runMigrations } from '@platform/db/migrations/runMigrations'
import { MIGRATIONS } from '@platform/db/migrations/schema'
import {
  seedAnalyticsHouseholdFixture,
  STANDALONE_FIXTURE_META,
} from '@platform/db/repositories/analyticsSeed'
import { SqliteAnalyticsAdapter } from '../SqliteAnalyticsAdapter'

describe('SqliteAnalyticsAdapter integration against MemorySqliteDriver (TR-10)', () => {
  it('filters local SQLite snapshots across all 5 dimensions and persists saved views', async () => {
    const db = await MemorySqliteDriver.create()
    try {
      await runMigrations(db, MIGRATIONS)
      await seedAnalyticsHouseholdFixture(db)

      const adapter = new SqliteAnalyticsAdapter(db)
      const filter = {
        ...createDefaultAnalyticsFilter(STANDALONE_FIXTURE_META.asOfDate),
        workspaceId: STANDALONE_FIXTURE_META.workspaceId,
        accountIds: ['acc_card_b'],
        categoryIds: ['cat_dining'],
        tagIds: ['tag_discretionary'],
        memberIds: ['mem_sam'],
        attributionMode: 'individual' as const,
        dateRangePreset: 'this_month' as const,
      }

      const sankey = await adapter.getCashFlowSankey(filter)
      expect(sankey.totalOutflowMinor).toBe(52_000)

      const drilldown = await adapter.listDrilldownTransactions(filter, {
        categoryId: 'cat_dining',
        period: '2026-11',
        onlyTransfers: false,
      })
      const drilldownNet = drilldown.reduce(
        (sum, t) => sum + (t.txType === 'expense' ? t.amountMinor : t.txType === 'income' ? -t.amountMinor : 0),
        0
      )
      expect(drilldownNet).toBe(52_000)

      const view: SavedAnalyticsView = {
        id: 'view_local_1',
        userId: STANDALONE_FIXTURE_META.userId,
        workspaceId: STANDALONE_FIXTURE_META.workspaceId,
        name: 'Sam Dining Individual',
        chartTab: 'sankey',
        filter,
        isPinned: true,
        createdAt: '2026-11-25T12:00:00Z',
        updatedAt: '2026-11-25T12:00:00Z',
      }
      await adapter.saveView(view)

      const listed = await adapter.listSavedViews(STANDALONE_FIXTURE_META.workspaceId)
      expect(listed).toHaveLength(1)
      expect(listed[0].name).toBe('Sam Dining Individual')
      expect(listed[0].filter.memberIds).toEqual(['mem_sam'])

      await adapter.deleteView('view_local_1')
      const afterDelete = await adapter.listSavedViews(STANDALONE_FIXTURE_META.workspaceId)
      expect(afterDelete).toHaveLength(0)
    } finally {
      await db.close()
    }
  })
})
