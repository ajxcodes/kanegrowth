import { invoke } from '@tauri-apps/api/core'
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
import type { AnalyticsUseCasePort } from '@ports/analytics/AnalyticsUseCasePort'
import type { LocalDb } from '@platform/db/LocalDb'
import { SqliteAnalyticsAdapter } from './SqliteAnalyticsAdapter'

/**
 * Driving adapter for the Tauri v2 desktop/mobile runtime. Delegates analytics
 * queries to the Rust `analytics_commands` IPC handlers backed by SQLCipher.
 */
export class TauriAnalyticsAdapter implements AnalyticsUseCasePort {
  private readonly fallbackSqlite: SqliteAnalyticsAdapter

  constructor(db: LocalDb) {
    this.fallbackSqlite = new SqliteAnalyticsAdapter(db)
  }

  async loadMetadata(
    filter: AnalyticsFilter
  ): Promise<Pick<LedgerSnapshot, 'accounts' | 'categories' | 'tags' | 'members'>> {
    return this.fallbackSqlite.loadMetadata(filter)
  }

  async getCashFlowSankey(filter: AnalyticsFilter): Promise<CashFlowSankeyGraph> {
    return invoke<CashFlowSankeyGraph>('analytics_get_cash_flow_sankey', { filter })
  }

  async getCategoryTrends(
    filter: AnalyticsFilter,
    rollingWindow = 3
  ): Promise<CategoryTrendsReport> {
    return invoke<CategoryTrendsReport>('analytics_get_category_trends', {
      filter,
      rollingWindow,
    })
  }

  async getNetWorthProjection(
    filter: AnalyticsFilter,
    options: DebtPayoffOptions = { extraMonthlyMinor: 0, lumpSumMinor: 0, projectionMonths: 24 }
  ): Promise<NetWorthAndDebtReport> {
    return invoke<NetWorthAndDebtReport>('analytics_get_net_worth_projection', {
      filter,
      options,
    })
  }

  async listDrilldownTransactions(
    filter: AnalyticsFilter,
    criteria: DrilldownCriteria
  ): Promise<TransactionRecord[]> {
    return invoke<TransactionRecord[]>('analytics_list_drilldown_transactions', {
      filter,
      criteria,
    })
  }

  async listSavedViews(workspaceId?: string | null): Promise<SavedAnalyticsView[]> {
    return invoke<SavedAnalyticsView[]>('analytics_list_saved_views', {
      workspaceId: workspaceId ?? null,
    })
  }

  async saveView(view: SavedAnalyticsView): Promise<SavedAnalyticsView> {
    return invoke<SavedAnalyticsView>('analytics_save_view', { view })
  }

  async deleteView(id: string): Promise<void> {
    return invoke<void>('analytics_delete_view', { id })
  }
}
