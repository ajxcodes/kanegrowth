import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SqliteAnalyticsAdapter } from '@adapters/analytics/SqliteAnalyticsAdapter'
import { MemorySqliteDriver } from '@platform/db/MemorySqliteDriver'
import { runMigrations } from '@platform/db/migrations/runMigrations'
import { MIGRATIONS } from '@platform/db/migrations/schema'
import { seedAnalyticsHouseholdFixture } from '@platform/db/repositories/analyticsSeed'
import { tableInvalidationBus } from '@lib/tableInvalidationBus'
import AnalyticsPage from '../AnalyticsPage'

describe('AnalyticsPage UI integration (TR-11)', () => {
  it('renders Sankey, Category Trends, Net Worth & Debt Payoff, cross-filters, and drill-down drawer', async () => {
    const db = await MemorySqliteDriver.create()
    try {
      await runMigrations(db, MIGRATIONS)
      await seedAnalyticsHouseholdFixture(db)
      const service = new SqliteAnalyticsAdapter(db)

      render(<AnalyticsPage serviceOverride={service} />)

      // 1. Sankey loads with canonical net totals ($6,500.00 inflow, $5,080.00 outflow, $800.00 excluded transfers)
      await waitFor(() => {
        expect(screen.getByTestId('sankey-svg')).toBeInTheDocument()
      })
      expect(screen.getByTestId('sankey-total-inflow')).toHaveTextContent('$6,500.00')
      expect(screen.getByTestId('sankey-total-outflow')).toHaveTextContent('$5,080.00')
      expect(screen.getByTestId('sankey-excluded-transfers')).toHaveTextContent('$800.00')

      // Toggle Exclude Internal Transfers off -> transfers included (+$800.00 outflow, $0 excluded)
      fireEvent.click(screen.getByTestId('sankey-exclude-transfers-toggle'))
      await waitFor(() => {
        expect(screen.getByTestId('sankey-excluded-transfers')).toHaveTextContent('$0.00')
      })
      expect(screen.getByTestId('sankey-total-outflow')).toHaveTextContent('$5,880.00')

      // Re-exclude transfers
      fireEvent.click(screen.getByTestId('sankey-exclude-transfers-toggle'))
      await waitFor(() => {
        expect(screen.getByTestId('sankey-total-outflow')).toHaveTextContent('$5,080.00')
      })

      // Click Dining Out Sankey link -> opens TransactionDrilldownDrawer with $520.00 total
      fireEvent.click(screen.getByTestId('sankey-link-link_pool_dst_cat_dining'))
      await waitFor(() => {
        expect(screen.getByTestId('drilldown-drawer')).toBeInTheDocument()
      })
      expect(screen.getByTestId('drilldown-total')).toHaveTextContent('$520.00')
      fireEvent.click(screen.getByTestId('drilldown-close-btn'))

      // 2. Switch to Category Trends tab & verify anomaly badge + drill-down
      fireEvent.click(screen.getByTestId('analytics-tab-trends'))
      await waitFor(() => {
        expect(screen.getByTestId('trends-svg')).toBeInTheDocument()
      })
      const anomalyBtn = screen.getByTestId('trend-anomaly-cat_dining-2026-11')
      expect(anomalyBtn).toHaveTextContent('$520.00')
      fireEvent.click(anomalyBtn)
      await waitFor(() => {
        expect(screen.getByTestId('drilldown-drawer')).toBeInTheDocument()
      })
      expect(screen.getByTestId('drilldown-total')).toHaveTextContent('$520.00')
      fireEvent.click(screen.getByTestId('drilldown-close-btn'))

      // 3. Switch to Net Worth & Debt Payoff tab & toggle strategy + extra monthly slider
      fireEvent.click(screen.getByTestId('analytics-tab-net_worth'))
      await waitFor(() => {
        expect(screen.getByTestId('networth-svg')).toBeInTheDocument()
      })
      expect(screen.getByTestId('networth-total')).toHaveTextContent('$79,000.00')

      const baseMonthsText = screen.getByTestId('debt-free-months').textContent
      fireEvent.change(screen.getByTestId('debt-extra-monthly-slider'), {
        target: { value: '25000' },
      })
      await waitFor(() => {
        expect(screen.getByTestId('debt-free-months').textContent).not.toBe(baseMonthsText)
      })

      fireEvent.click(screen.getByTestId('debt-strategy-snowball'))
      expect(screen.getByTestId('debt-total-interest')).toBeInTheDocument()

      // 4. Apply member filter chip
      fireEvent.click(screen.getByTestId('filter-member-mem_sam'))
      expect(screen.getByTestId('filter-member-mem_sam')).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await db.close()
    }
  })
})

describe('AnalyticsPage invalidation refresh (TR-16)', () => {
  it('refreshes analytics when the local ledger is invalidated after a demo reset', async () => {
    const db = await MemorySqliteDriver.create()
    try {
      await runMigrations(db, MIGRATIONS)
      await seedAnalyticsHouseholdFixture(db)
      const service = new SqliteAnalyticsAdapter(db)
      const original = service.getCashFlowSankey.bind(service)
      let sankeyCalls = 0
      vi.spyOn(service, 'getCashFlowSankey').mockImplementation(async (filter) => {
        sankeyCalls += 1
        return original(filter)
      })

      render(<AnalyticsPage serviceOverride={service} />)

      await waitFor(() => {
        expect(screen.getByTestId('sankey-svg')).toBeInTheDocument()
      })
      expect(sankeyCalls).toBe(1)

      act(() => {
        tableInvalidationBus.publish('accounts')
      })
      await waitFor(() => {
        expect(sankeyCalls).toBe(2)
      })
    } finally {
      await db.close()
    }
  })
})
