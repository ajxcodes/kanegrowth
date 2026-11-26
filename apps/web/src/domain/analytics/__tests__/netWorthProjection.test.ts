import { describe, expect, it } from 'vitest'
import householdFixture from '@fixtures/analytics/household_fixture.json'
import { createDefaultAnalyticsFilter } from '../analyticsFilter'
import { computeNetWorthAndDebt } from '../netWorthProjection'
import type { LedgerSnapshot } from '../types'

describe('Net worth & debt payoff projection domain math (TR-8)', () => {
  it('reconstructs historical assets vs liabilities by account group and projects snowball vs avalanche payoff', () => {
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

    const baseReport = computeNetWorthAndDebt(snapshot, filter, {
      extraMonthlyMinor: 0,
      lumpSumMinor: 0,
      projectionMonths: 24,
    })

    const latest = baseReport.timeline[baseReport.timeline.length - 1]
    expect(latest.assetsMinor).toBe(9_450_000)
    expect(latest.liabilitiesMinor).toBe(1_550_000)
    expect(latest.netWorthMinor).toBe(latest.assetsMinor - latest.liabilitiesMinor)
    expect(latest.byAccountGroup.banking).toBe(1_450_000)
    expect(latest.byAccountGroup.cash).toBe(2_200_000)
    expect(latest.byAccountGroup.investment).toBe(5_800_000)
    expect(latest.byAccountGroup.credit).toBe(-600_000)
    expect(latest.byAccountGroup.loan).toBe(-950_000)

    const acceleratedReport = computeNetWorthAndDebt(snapshot, filter, {
      extraMonthlyMinor: 25_000,
      lumpSumMinor: 100_000,
      projectionMonths: 24,
    })
    expect(acceleratedReport.avalanche.debtFreeMonths).toBeLessThan(
      baseReport.avalanche.debtFreeMonths
    )
    expect(acceleratedReport.avalanche.totalInterestPaidMinor).toBeLessThan(
      baseReport.avalanche.totalInterestPaidMinor
    )
    expect(acceleratedReport.avalanche.totalInterestPaidMinor).toBeLessThan(
      acceleratedReport.snowball.totalInterestPaidMinor
    )
  })
})
