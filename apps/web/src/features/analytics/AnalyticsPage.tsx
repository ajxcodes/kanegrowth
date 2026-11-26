import React from 'react'
import type { AnalyticsChartTab } from '@domain/analytics/types'
import type { AnalyticsUseCasePort } from '@ports/analytics/AnalyticsUseCasePort'
import AnalyticsFilterBar from './components/AnalyticsFilterBar'
import CashFlowSankeyChart from './components/CashFlowSankeyChart'
import CategoryTrendsChart from './components/CategoryTrendsChart'
import NetWorthDebtWorkbench from './components/NetWorthDebtWorkbench'
import SavedViewsBar from './components/SavedViewsBar'
import ThemeToggle from './components/ThemeToggle'
import TransactionDrilldownDrawer from './components/TransactionDrilldownDrawer'
import { useAnalyticsData } from './hooks/useAnalyticsData'

interface AnalyticsPageProps {
  serviceOverride?: AnalyticsUseCasePort
}

const TABS: Array<{ id: AnalyticsChartTab; label: string }> = [
  { id: 'sankey', label: 'Cash Flow Sankey' },
  { id: 'trends', label: 'Category Trends' },
  { id: 'net_worth', label: 'Net Worth & Debt Payoff' },
]

const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ serviceOverride }) => {
  const {
    activeTab,
    setActiveTab,
    filter,
    setFilter,
    debtOptions,
    setDebtOptions,
    rollingWindow,
    setRollingWindow,
    metadata,
    sankey,
    trends,
    netWorth,
    savedViews,
    loading,
    error,
    drilldownState,
    openDrilldown,
    closeDrilldown,
    saveCurrentView,
    applySavedView,
    deleteSavedView,
    resetFilters,
  } = useAnalyticsData({ serviceOverride })

  return (
    <div
      data-testid="analytics-page"
      className="mx-auto w-full max-w-6xl space-y-4 overflow-x-hidden px-3 py-4 sm:px-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
            Enhanced Analytics
          </h1>
          <p className="text-xs text-text-muted">
            Offline-first household cash flow, category trends, and net worth / debt projections.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <SavedViewsBar
        views={savedViews}
        onSave={saveCurrentView}
        onApply={applySavedView}
        onDelete={deleteSavedView}
      />

      <AnalyticsFilterBar
        filter={filter}
        metadata={metadata}
        onChange={setFilter}
        onReset={resetFilters}
      />

      <nav
        aria-label="Analytics chart sections"
        className="flex flex-wrap gap-2 border-b border-border pb-2"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={`analytics-tab-${tab.id}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              activeTab === tab.id
                ? 'bg-accent text-on-accent'
                : 'bg-elevated text-text-secondary hover:bg-elevated-hover'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-negative-border bg-negative-subtle p-3 text-xs text-negative"
        >
          {error}
        </div>
      )}

      {loading && !sankey ? (
        <div className="rounded-xl border border-border bg-elevated p-10 text-center text-sm text-text-muted">
          Computing analytics from local SQLite ledger...
        </div>
      ) : (
        <>
          {activeTab === 'sankey' && (
            <CashFlowSankeyChart
              graph={sankey}
              filter={filter}
              onFilterChange={setFilter}
              onDrilldown={openDrilldown}
            />
          )}

          {activeTab === 'trends' && (
            <CategoryTrendsChart
              report={trends}
              rollingWindow={rollingWindow}
              onRollingWindowChange={setRollingWindow}
              onDrilldown={openDrilldown}
            />
          )}

          {activeTab === 'net_worth' && (
            <NetWorthDebtWorkbench
              report={netWorth}
              options={debtOptions}
              onOptionsChange={setDebtOptions}
            />
          )}
        </>
      )}

      <TransactionDrilldownDrawer
        open={drilldownState.open}
        title={drilldownState.title}
        expectedMinor={drilldownState.expectedMinor}
        transactions={drilldownState.transactions}
        loading={drilldownState.loading}
        onClose={closeDrilldown}
      />
    </div>
  )
}

export default AnalyticsPage
