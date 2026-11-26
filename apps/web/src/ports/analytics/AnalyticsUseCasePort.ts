import type {
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

export interface AnalyticsUseCasePort {
  loadMetadata(filter: AnalyticsFilter): Promise<Pick<LedgerSnapshot, 'accounts' | 'categories' | 'tags' | 'members'>>
  getCashFlowSankey(filter: AnalyticsFilter): Promise<CashFlowSankeyGraph>
  getCategoryTrends(filter: AnalyticsFilter, rollingWindow?: number): Promise<CategoryTrendsReport>
  getNetWorthProjection(
    filter: AnalyticsFilter,
    options?: DebtPayoffOptions
  ): Promise<NetWorthAndDebtReport>
  listDrilldownTransactions(
    filter: AnalyticsFilter,
    criteria: DrilldownCriteria
  ): Promise<TransactionRecord[]>
  listSavedViews(workspaceId?: string | null): Promise<SavedAnalyticsView[]>
  saveView(view: SavedAnalyticsView): Promise<SavedAnalyticsView>
  deleteView(id: string): Promise<void>
}
