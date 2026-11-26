import { useCallback, useEffect, useState } from 'react'
import { createDefaultAnalyticsFilter } from '@domain/analytics/analyticsFilter'
import type {
  AnalyticsChartTab,
  AnalyticsFilter,
  CashFlowSankeyGraph,
  CategoryTrendsReport,
  DebtPayoffOptions,
  DrilldownCriteria,
  LedgerSnapshot,
  NetWorthAndDebtReport,
  SavedAnalyticsView,
  TransactionRecord,
} from '@domain/analytics/types'
import type { AnalyticsUseCasePort } from '@ports/analytics/AnalyticsUseCasePort'
import { createAnalyticsService } from '@adapters/analytics/createAnalyticsService'
import { STANDALONE_FIXTURE_META } from '@platform/db/repositories/analyticsSeed'

export interface UseAnalyticsDataOptions {
  serviceOverride?: AnalyticsUseCasePort
  asOfDate?: string
  workspaceId?: string | null
  userId?: string
}

export interface AnalyticsMetadata {
  accounts: LedgerSnapshot['accounts']
  categories: LedgerSnapshot['categories']
  tags: LedgerSnapshot['tags']
  members: LedgerSnapshot['members']
}

export const formatMinorCurrency = (minor: number): string => {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(minor))
  const dollars = Math.floor(abs / 100)
  const cents = abs % 100
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`
}

export const useAnalyticsData = (options?: UseAnalyticsDataOptions) => {
  const defaultAsOfDate = options?.asOfDate ?? STANDALONE_FIXTURE_META.asOfDate
  const workspaceId = options?.workspaceId ?? STANDALONE_FIXTURE_META.workspaceId
  const userId = options?.userId ?? STANDALONE_FIXTURE_META.userId

  const [activeTab, setActiveTab] = useState<AnalyticsChartTab>('sankey')
  const [filter, setFilter] = useState<AnalyticsFilter>(() => ({
    ...createDefaultAnalyticsFilter(defaultAsOfDate),
    workspaceId,
  }))
  const [debtOptions, setDebtOptions] = useState<DebtPayoffOptions>({
    extraMonthlyMinor: 0,
    lumpSumMinor: 0,
    projectionMonths: 24,
  })
  const [rollingWindow, setRollingWindow] = useState<number>(3)

  const [metadata, setMetadata] = useState<AnalyticsMetadata>({
    accounts: [],
    categories: [],
    tags: [],
    members: [],
  })
  const [sankey, setSankey] = useState<CashFlowSankeyGraph | null>(null)
  const [trends, setTrends] = useState<CategoryTrendsReport | null>(null)
  const [netWorth, setNetWorth] = useState<NetWorthAndDebtReport | null>(null)
  const [savedViews, setSavedViews] = useState<SavedAnalyticsView[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const [drilldownState, setDrilldownState] = useState<{
    open: boolean
    title: string
    expectedMinor: number | null
    transactions: TransactionRecord[]
    loading: boolean
  }>({
    open: false,
    title: '',
    expectedMinor: null,
    transactions: [],
    loading: false,
  })

  const getService = useCallback(async (): Promise<AnalyticsUseCasePort> => {
    if (options?.serviceOverride) return options.serviceOverride
    return createAnalyticsService()
  }, [options?.serviceOverride])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const svc = await getService()
      const [meta, sankeyRes, trendsRes, nwRes, viewsRes] = await Promise.all([
        svc.loadMetadata(filter),
        svc.getCashFlowSankey(filter),
        svc.getCategoryTrends(filter, rollingWindow),
        svc.getNetWorthProjection(filter, debtOptions),
        svc.listSavedViews(filter.workspaceId),
      ])
      setMetadata(meta)
      setSankey(sankeyRes)
      setTrends(trendsRes)
      setNetWorth(nwRes)
      setSavedViews(viewsRes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [debtOptions, filter, getService, rollingWindow])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openDrilldown = useCallback(
    async (title: string, expectedMinor: number | null, criteria: DrilldownCriteria) => {
      setDrilldownState({
        open: true,
        title,
        expectedMinor,
        transactions: [],
        loading: true,
      })
      try {
        const svc = await getService()
        const txs = await svc.listDrilldownTransactions(filter, criteria)
        setDrilldownState({
          open: true,
          title,
          expectedMinor,
          transactions: txs,
          loading: false,
        })
      } catch {
        setDrilldownState((prev) => ({ ...prev, loading: false }))
      }
    },
    [filter, getService]
  )

  const closeDrilldown = useCallback(() => {
    setDrilldownState((prev) => ({ ...prev, open: false }))
  }, [])

  const saveCurrentView = useCallback(
    async (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const svc = await getService()
      const now = new Date().toISOString()
      const view: SavedAnalyticsView = {
        id: `view_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId,
        workspaceId: filter.workspaceId,
        name: trimmed,
        chartTab: activeTab,
        filter,
        isPinned: false,
        createdAt: now,
        updatedAt: now,
      }
      await svc.saveView(view)
      const updated = await svc.listSavedViews(filter.workspaceId)
      setSavedViews(updated)
    },
    [activeTab, filter, getService, userId]
  )

  const applySavedView = useCallback((view: SavedAnalyticsView) => {
    setActiveTab(view.chartTab)
    setFilter(view.filter)
  }, [])

  const deleteSavedView = useCallback(
    async (id: string) => {
      const svc = await getService()
      await svc.deleteView(id)
      const updated = await svc.listSavedViews(filter.workspaceId)
      setSavedViews(updated)
    },
    [filter.workspaceId, getService]
  )

  const resetFilters = useCallback(() => {
    setFilter({
      ...createDefaultAnalyticsFilter(defaultAsOfDate),
      workspaceId,
    })
  }, [defaultAsOfDate, workspaceId])

  return {
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
    refresh,
  }
}
