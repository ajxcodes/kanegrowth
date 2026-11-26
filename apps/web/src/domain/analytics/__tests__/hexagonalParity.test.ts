import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import householdFixture from '@fixtures/analytics/household_fixture.json'
import { createDefaultAnalyticsFilter } from '../analyticsFilter'
import { computeCashFlowSankey } from '../cashFlowSankey'
import { computeCategoryTrends } from '../categoryTrends'
import { computeNetWorthAndDebt } from '../netWorthProjection'
import type { LedgerSnapshot } from '../types'

const testDir = dirname(fileURLToPath(import.meta.url))
const domainAnalyticsDir = resolve(testDir, '..')

describe('Hexagonal analytics domain parity & isolation (TR-2)', () => {
  it('matches canonical household_fixture.json outputs and enforces pure domain isolation', () => {
    const snapshot: LedgerSnapshot = {
      accounts: householdFixture.accounts as LedgerSnapshot['accounts'],
      categories: householdFixture.categories as LedgerSnapshot['categories'],
      tags: householdFixture.tags,
      members: householdFixture.members,
      recurringRules: householdFixture.recurringRules as LedgerSnapshot['recurringRules'],
      transactions: householdFixture.transactions as LedgerSnapshot['transactions'],
    }

    // 1. Net & Gross Sankey parity
    const netFilter = createDefaultAnalyticsFilter(householdFixture.asOfDate)
    const netSankey = computeCashFlowSankey(snapshot, netFilter)
    expect(netSankey.totalInflowMinor).toBe(householdFixture.expected.thisMonthNetSankey.totalInflowMinor)
    expect(netSankey.totalOutflowMinor).toBe(householdFixture.expected.thisMonthNetSankey.totalOutflowMinor)
    expect(netSankey.netSavingsMinor).toBe(householdFixture.expected.thisMonthNetSankey.netSavingsMinor)
    expect(netSankey.excludedTransferMinor).toBe(
      householdFixture.expected.thisMonthNetSankey.excludedTransferMinor
    )

    const grossSankey = computeCashFlowSankey(snapshot, { ...netFilter, flowBasis: 'gross' })
    expect(grossSankey.totalInflowMinor).toBe(
      householdFixture.expected.thisMonthGrossSankey.totalInflowMinor
    )
    expect(grossSankey.totalOutflowMinor).toBe(
      householdFixture.expected.thisMonthGrossSankey.totalOutflowMinor
    )

    // 2. Category Trends parity
    const trends = computeCategoryTrends(
      snapshot,
      { ...netFilter, dateRangePreset: 'last_12_months' },
      3
    )
    const novDining = trends.series.find(
      (p) => p.period === '2026-11' && p.categoryId === 'cat_dining'
    )
    expect(novDining).toBeDefined()
    expect(novDining?.amountMinor).toBe(householdFixture.expected.diningTrend202611.amountMinor)
    expect(novDining?.rollingAvgMinor).toBe(
      householdFixture.expected.diningTrend202611.rollingAvgMinor
    )
    expect(novDining?.priorYearAmountMinor).toBe(
      householdFixture.expected.diningTrend202611.priorYearAmountMinor
    )
    expect(novDining?.yoyDeltaMinor).toBe(householdFixture.expected.diningTrend202611.yoyDeltaMinor)
    expect(novDining?.overageMinor).toBe(householdFixture.expected.diningTrend202611.overageMinor)
    expect(novDining?.isOverThreshold).toBe(
      householdFixture.expected.diningTrend202611.isOverThreshold
    )
    expect(novDining?.isAnomaly).toBe(householdFixture.expected.diningTrend202611.isAnomaly)

    // 3. Net Worth parity
    const nw = computeNetWorthAndDebt(snapshot, {
      ...netFilter,
      dateRangePreset: 'last_12_months',
    })
    const latest = nw.timeline[nw.timeline.length - 1]
    expect(latest.assetsMinor).toBe(householdFixture.expected.latestNetWorth.assetsMinor)
    expect(latest.liabilitiesMinor).toBe(householdFixture.expected.latestNetWorth.liabilitiesMinor)
    expect(latest.netWorthMinor).toBe(householdFixture.expected.latestNetWorth.netWorthMinor)

    // 4. Pure domain isolation: zero DB, Tauri, React, or UI imports
    const domainFiles = fs
      .readdirSync(domainAnalyticsDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(domainFiles.length).toBeGreaterThanOrEqual(5)
    for (const file of domainFiles) {
      const content = fs.readFileSync(resolve(domainAnalyticsDir, file), 'utf8')
      expect(content).not.toMatch(/from\s+['"](react|@tauri-apps|@sqlite\.org|@platform|@adapters|@features|@ui)/)
    }
  })
})
