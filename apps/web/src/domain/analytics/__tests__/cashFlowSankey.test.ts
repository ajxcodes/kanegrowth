import { describe, expect, it } from 'vitest'
import { createDefaultAnalyticsFilter } from '../analyticsFilter'
import { computeCashFlowSankey } from '../cashFlowSankey'
import type { LedgerSnapshot } from '../types'

describe('Cash Flow Sankey domain math (TR-4)', () => {
  it('excludes split parents and internal transfers while preserving node flow conservation', () => {
    const snapshot: LedgerSnapshot = {
      accounts: [
        {
          id: 'acc_1',
          name: 'Checking',
          accountType: 'checking',
          accountGroup: 'banking',
          currency: 'USD',
          currentBalanceMinor: 500_000,
          isLiability: false,
          interestRateBps: 0,
          minimumPaymentMinor: 0,
        },
      ],
      categories: [
        { id: 'cat_inc', name: 'Salary', envelopeType: 'income', monthlyTargetMinor: 0 },
        { id: 'cat_groc', name: 'Groceries', envelopeType: 'expense', monthlyTargetMinor: 60_000 },
        { id: 'cat_xfer', name: 'Transfer', envelopeType: 'transfer', monthlyTargetMinor: 0 },
      ],
      tags: [],
      members: [],
      recurringRules: [],
      transactions: [
        {
          id: 't_inc',
          accountId: 'acc_1',
          categoryId: 'cat_inc',
          txType: 'income',
          status: 'posted',
          amountMinor: 200_000,
          date: '2026-11-01',
          description: 'Salary',
          memberId: null,
          isShared: true,
          transferPairId: null,
          hasSplitChildren: false,
          splitTransactionId: null,
          tagIds: [],
        },
        {
          id: 't_split_parent',
          accountId: 'acc_1',
          categoryId: 'cat_groc',
          txType: 'expense',
          status: 'posted',
          amountMinor: 50_000,
          date: '2026-11-05',
          description: 'Split Parent',
          memberId: null,
          isShared: true,
          transferPairId: null,
          hasSplitChildren: true,
          splitTransactionId: null,
          tagIds: [],
        },
        {
          id: 't_split_c1',
          accountId: 'acc_1',
          categoryId: 'cat_groc',
          txType: 'expense',
          status: 'posted',
          amountMinor: 30_000,
          date: '2026-11-05',
          description: 'Split Child 1',
          memberId: null,
          isShared: true,
          transferPairId: null,
          hasSplitChildren: false,
          splitTransactionId: 't_split_parent',
          tagIds: [],
        },
        {
          id: 't_split_c2',
          accountId: 'acc_1',
          categoryId: 'cat_groc',
          txType: 'expense',
          status: 'posted',
          amountMinor: 20_000,
          date: '2026-11-05',
          description: 'Split Child 2',
          memberId: null,
          isShared: true,
          transferPairId: null,
          hasSplitChildren: false,
          splitTransactionId: 't_split_parent',
          tagIds: [],
        },
        {
          id: 't_xfer',
          accountId: 'acc_1',
          categoryId: 'cat_xfer',
          txType: 'transfer',
          status: 'posted',
          amountMinor: 40_000,
          date: '2026-11-06',
          description: 'Internal Transfer',
          memberId: null,
          isShared: true,
          transferPairId: 'pair_1',
          hasSplitChildren: false,
          splitTransactionId: null,
          tagIds: [],
        },
      ],
    }

    const filter = createDefaultAnalyticsFilter('2026-11-25')
    const graph = computeCashFlowSankey(snapshot, filter)

    // Split parent (50_000) is NOT double-counted alongside children (30_000 + 20_000 = 50_000)
    expect(graph.totalOutflowMinor).toBe(50_000)
    expect(graph.excludedTransferMinor).toBe(40_000)
    expect(graph.netSavingsMinor).toBe(150_000)

    const tier0Sum = graph.nodes
      .filter((n) => n.tier === 0)
      .reduce((sum, n) => sum + n.amountMinor, 0)
    const tier2Sum = graph.nodes
      .filter((n) => n.tier === 2)
      .reduce((sum, n) => sum + n.amountMinor, 0)
    expect(tier0Sum).toBe(200_000)
    expect(tier2Sum).toBe(tier0Sum)
  })
})
