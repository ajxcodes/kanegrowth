import type {
  AnalyticsFilter,
  DrilldownCriteria,
  LedgerSnapshot,
  TransactionRecord,
} from '@domain/analytics/types'

export interface AnalyticsLedgerPort {
  loadLedgerSnapshot(filter: AnalyticsFilter): Promise<LedgerSnapshot>
  listDrilldownTransactions(
    filter: AnalyticsFilter,
    criteria: DrilldownCriteria
  ): Promise<TransactionRecord[]>
}
