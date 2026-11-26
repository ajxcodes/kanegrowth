import { describe, expect, it } from 'vitest'
import householdFixture from '@fixtures/analytics/household_fixture.json'
import { createDefaultAnalyticsFilter } from '../analyticsFilter'
import { computeCategoryTrends } from '../categoryTrends'
import type { LedgerSnapshot } from '../types'

describe('Category spending trends domain math (TR-6)', () => {
  it('computes MoM, rolling average, YoY delta, and flags budget threshold overages', () => {
    const snapshot: LedgerSnapshot = {
      accounts: householdFixture.accounts as LedgerSnapshot['accounts'],
      categories: householdFixture.categories as LedgerSnapshot['categories'],
      tags: householdFixture.tags,
      members: householdFixture.members,
      recurringRules: householdFixture.recurringRules as LedgerSnapshot['recurringRules'],
      transactions: householdFixture.transactions as LedgerSnapshot['transactions'],
    }

    const filter = {
      ...createDefaultAnalyticsFilter(householdFixture.asOfDate),
      dateRangePreset: 'last_12_months' as const,
    }
    const report = computeCategoryTrends(snapshot, filter, 3)

    const novDining = report.series.find(
      (p) => p.period === '2026-11' && p.categoryId === 'cat_dining'
    )
    expect(novDining).toBeDefined()
    expect(novDining?.amountMinor).toBe(52_000)
    expect(novDining?.rollingAvgMinor).toBe(41_000)
    expect(novDining?.yoyDeltaMinor).toBe(13_000)
    expect(novDining?.overageMinor).toBe(12_000)
    expect(novDining?.isOverThreshold).toBe(true)
    expect(novDining?.isAnomaly).toBe(true)

    // Zero prior-year spend produces null yoyDeltaPct instead of Infinity/NaN
    const zeroPriorSnapshot: LedgerSnapshot = {
      ...snapshot,
      transactions: [
        {
          id: 'tx_only_current',
          accountId: 'acc_card_b',
          categoryId: 'cat_dining',
          txType: 'expense',
          status: 'posted',
          amountMinor: 25_000,
          date: '2026-11-10',
          description: 'New Dining',
          memberId: 'mem_sam',
          isShared: false,
          transferPairId: null,
          hasSplitChildren: false,
          splitTransactionId: null,
          tagIds: [],
        },
      ],
    }
    const zeroPriorReport = computeCategoryTrends(
      zeroPriorSnapshot,
      createDefaultAnalyticsFilter('2026-11-25'),
      3
    )
    expect(zeroPriorReport.series[0]?.yoyDeltaPct).toBeNull()
  })
})
