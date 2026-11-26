import { resolveDateBounds } from '@domain/analytics/analyticsFilter'
import { computeCashFlowSankey } from '@domain/analytics/cashFlowSankey'
import { computeCategoryTrends } from '@domain/analytics/categoryTrends'
import { computeNetWorthAndDebt } from '@domain/analytics/netWorthProjection'
import type {
  AccountGroup,
  AccountRecord,
  AnalyticsChartTab,
  AnalyticsFilter,
  CashFlowSankeyGraph,
  CategoryRecord,
  CategoryTrendsReport,
  DebtPayoffOptions,
  DrilldownCriteria,
  EnvelopeType,
  LedgerSnapshot,
  MemberRecord,
  NetWorthAndDebtReport,
  RecurringRuleRecord,
  SavedAnalyticsView,
  TagRecord,
  TransactionRecord,
  TxType,
} from '@domain/analytics/types'
import type { AnalyticsLedgerPort } from '@ports/analytics/AnalyticsLedgerPort'
import type { AnalyticsUseCasePort } from '@ports/analytics/AnalyticsUseCasePort'
import type { SavedViewRepositoryPort } from '@ports/analytics/SavedViewRepositoryPort'
import type { LocalDb } from '@platform/db/LocalDb'

const MEMORY_VIEWS_STORAGE_KEY = 'kanegrowth_saved_analytics_views_v1'

const parseAccountGroup = (raw: unknown): AccountGroup => {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'investment' || s === 'brokerage' || s === 'retirement') return 'investment'
  if (s === 'cash' || s === 'savings') return 'cash'
  if (s === 'credit' || s === 'credit_card') return 'credit'
  if (s === 'loan' || s === 'mortgage' || s === 'debt') return 'loan'
  return 'banking'
}

const parseEnvelopeType = (raw: unknown): EnvelopeType => {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'income') return 'income'
  if (s === 'sinking_fund') return 'sinking_fund'
  if (s === 'savings') return 'savings'
  if (s === 'transfer') return 'transfer'
  return 'expense'
}

const parseTxType = (raw: unknown): TxType => {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'income') return 'income'
  if (s === 'transfer') return 'transfer'
  return 'expense'
}

const parseChartTab = (raw: unknown): AnalyticsChartTab => {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'trends') return 'trends'
  if (s === 'net_worth') return 'net_worth'
  return 'sankey'
}

export class SqliteAnalyticsAdapter
  implements AnalyticsLedgerPort, SavedViewRepositoryPort, AnalyticsUseCasePort
{
  private readonly db: LocalDb
  private readonly persistViewsToLocalStorageFallback: boolean

  constructor(db: LocalDb, options?: { persistViewsToLocalStorageFallback?: boolean }) {
    this.db = db
    this.persistViewsToLocalStorageFallback = options?.persistViewsToLocalStorageFallback ?? false
  }

  private async loadTagMap(): Promise<Map<string, string[]>> {
    const rows = await this.db.select<{ transactionId: string; tagId: string }>(
      'SELECT transactionId, tagId FROM transaction_tags ORDER BY transactionId, tagId'
    )
    const map = new Map<string, string[]>()
    for (const row of rows) {
      const list = map.get(row.transactionId) ?? []
      list.push(row.tagId)
      map.set(row.transactionId, list)
    }
    return map
  }

  private buildTransactionQuery(
    filter: AnalyticsFilter,
    dateBounds: [string, string] | null,
    criteria: DrilldownCriteria | null,
    respectTransferFlag: boolean
  ): { sql: string; params: unknown[] } {
    const clauses: string[] = [
      't.deletedAt IS NULL',
      "t.status != 'draft'",
      't.hasSplitChildren = 0',
    ]
    const params: unknown[] = []

    if (filter.workspaceId) {
      clauses.push('t.workspaceId = ?')
      params.push(filter.workspaceId)
    }

    if (dateBounds) {
      clauses.push('substr(t.date, 1, 10) >= ?')
      params.push(dateBounds[0])
      clauses.push('substr(t.date, 1, 10) <= ?')
      params.push(dateBounds[1])
    }

    if (criteria) {
      if (criteria.onlyTransfers) {
        clauses.push("(t.type = 'transfer' OR t.transferPairId IS NOT NULL)")
      } else if (respectTransferFlag && !filter.includeTransfers) {
        clauses.push("(t.type != 'transfer' AND t.transferPairId IS NULL)")
      }
      if (criteria.categoryId) {
        clauses.push('t.categoryId = ?')
        params.push(criteria.categoryId)
      }
      if (criteria.period) {
        clauses.push('substr(t.date, 1, 7) = ?')
        params.push(criteria.period)
      }
    } else if (respectTransferFlag && !filter.includeTransfers) {
      clauses.push("(t.type != 'transfer' AND t.transferPairId IS NULL)")
    }

    if (filter.accountIds.length > 0) {
      clauses.push(`t.accountId IN (${filter.accountIds.map(() => '?').join(', ')})`)
      params.push(...filter.accountIds)
    }

    if (filter.categoryIds.length > 0) {
      clauses.push(`t.categoryId IN (${filter.categoryIds.map(() => '?').join(', ')})`)
      params.push(...filter.categoryIds)
    }

    if (filter.memberIds.length > 0) {
      clauses.push(`t.memberId IN (${filter.memberIds.map(() => '?').join(', ')})`)
      params.push(...filter.memberIds)
    }

    if (filter.attributionMode === 'shared') {
      clauses.push('t.isShared = 1')
    } else if (filter.attributionMode === 'individual') {
      clauses.push('t.isShared = 0')
    }

    if (filter.tagIds.length > 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transactionId = t._id AND tt.tagId IN (${filter.tagIds.map(() => '?').join(', ')}))`
      )
      params.push(...filter.tagIds)
    }

    const sql =
      `SELECT t._id, t.accountId, t.categoryId, t.type, t.status, t.amount, t.date, t.data, ` +
      `t.memberId, t.isShared, t.transferPairId, t.hasSplitChildren, t.splitTransactionId, t.tagsJson ` +
      `FROM transactions t WHERE ${clauses.join(' AND ')} ORDER BY t.date DESC, t._id ASC`
    return { sql, params }
  }

  private async queryTransactions(
    sql: string,
    params: unknown[],
    tagMap: Map<string, string[]>
  ): Promise<TransactionRecord[]> {
    const rows = await this.db.select<Record<string, unknown>>(sql, params)
    return rows.map((row) => {
      const id = String(row._id)
      let description = ''
      try {
        const parsed = JSON.parse(String(row.data ?? '{}')) as Record<string, unknown>
        description = String(parsed.description ?? parsed.note ?? '')
      } catch {
        description = ''
      }
      let tagIds = tagMap.get(id)
      if (!tagIds) {
        try {
          const parsedTags = JSON.parse(String(row.tagsJson ?? '[]'))
          tagIds = Array.isArray(parsedTags) ? parsedTags.map(String) : []
        } catch {
          tagIds = []
        }
      }

      return {
        id,
        accountId: String(row.accountId),
        categoryId: String(row.categoryId),
        txType: parseTxType(row.type),
        status: String(row.status ?? 'posted'),
        amountMinor: Math.trunc(Number(row.amount ?? 0)),
        date: String(row.date),
        description,
        memberId: row.memberId ? String(row.memberId) : null,
        isShared: Number(row.isShared ?? 1) !== 0,
        transferPairId: row.transferPairId ? String(row.transferPairId) : null,
        hasSplitChildren: Number(row.hasSplitChildren ?? 0) !== 0,
        splitTransactionId: row.splitTransactionId ? String(row.splitTransactionId) : null,
        tagIds,
      }
    })
  }

  async loadLedgerSnapshot(filter: AnalyticsFilter): Promise<LedgerSnapshot> {
    const [accountRows, categoryRows, tagRows, memberRows, ruleRows, tagMap] = await Promise.all([
      this.db.select<Record<string, unknown>>(
        'SELECT _id, name, type, accountGroup, currency, CAST(ROUND(currentBalance) AS INTEGER) AS currentBalance, ' +
          'isLiability, interestRateBps, minimumPaymentMinor ' +
          'FROM accounts WHERE deletedAt IS NULL AND isArchived = 0 ORDER BY name ASC'
      ),
      this.db.select<Record<string, unknown>>(
        'SELECT _id, name, envelopeType, monthlyTargetMinor ' +
          'FROM categories WHERE deletedAt IS NULL AND isArchived = 0 ORDER BY name ASC'
      ),
      this.db.select<Record<string, unknown>>(
        'SELECT _id, name FROM tags WHERE deletedAt IS NULL ORDER BY name ASC'
      ),
      this.db.select<Record<string, unknown>>(
        'SELECT _id, name, role, color FROM household_members WHERE deletedAt IS NULL AND isArchived = 0 ORDER BY name ASC'
      ),
      this.db.select<Record<string, unknown>>(
        'SELECT _id, accountId, categoryId, isActive, data FROM recurringRules WHERE deletedAt IS NULL AND isArchived = 0'
      ),
      this.loadTagMap(),
    ])

    const accounts: AccountRecord[] = accountRows.map((r) => ({
      id: String(r._id),
      name: String(r.name),
      accountType: String(r.type),
      accountGroup: parseAccountGroup(r.accountGroup),
      currency: String(r.currency ?? 'USD'),
      currentBalanceMinor: Math.trunc(Number(r.currentBalance ?? 0)),
      isLiability: Number(r.isLiability ?? 0) !== 0,
      interestRateBps: Math.trunc(Number(r.interestRateBps ?? 0)),
      minimumPaymentMinor: Math.trunc(Number(r.minimumPaymentMinor ?? 0)),
    }))

    const categories: CategoryRecord[] = categoryRows.map((r) => ({
      id: String(r._id),
      name: String(r.name),
      envelopeType: parseEnvelopeType(r.envelopeType),
      monthlyTargetMinor: Math.trunc(Number(r.monthlyTargetMinor ?? 0)),
    }))

    const tags: TagRecord[] = tagRows.map((r) => ({
      id: String(r._id),
      name: String(r.name),
    }))

    const members: MemberRecord[] = memberRows.map((r) => ({
      id: String(r._id),
      name: String(r.name),
      role: String(r.role ?? 'member'),
      color: String(r.color ?? '#8a6a12'),
    }))

    const recurringRules: RecurringRuleRecord[] = ruleRows.map((r) => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(String(r.data ?? '{}')) as Record<string, unknown>
      } catch {
        parsed = {}
      }
      return {
        id: String(r._id),
        accountId: String(r.accountId),
        categoryId: String(r.categoryId),
        txType: parseTxType(parsed.type),
        amountMinor: Math.trunc(Number(parsed.amountMinor ?? parsed.amount ?? 0)),
        cadence: String(parsed.cadence ?? 'monthly'),
        isActive: Number(r.isActive ?? 1) !== 0,
      }
    })

    const { sql, params } = this.buildTransactionQuery(filter, null, null, false)
    const transactions = await this.queryTransactions(sql, params, tagMap)

    return {
      accounts,
      categories,
      tags,
      members,
      recurringRules,
      transactions,
    }
  }

  async loadMetadata(
    filter: AnalyticsFilter
  ): Promise<Pick<LedgerSnapshot, 'accounts' | 'categories' | 'tags' | 'members'>> {
    const snap = await this.loadLedgerSnapshot(filter)
    return {
      accounts: snap.accounts,
      categories: snap.categories,
      tags: snap.tags,
      members: snap.members,
    }
  }

  async getCashFlowSankey(filter: AnalyticsFilter): Promise<CashFlowSankeyGraph> {
    const snapshot = await this.loadLedgerSnapshot(filter)
    return computeCashFlowSankey(snapshot, filter)
  }

  async getCategoryTrends(
    filter: AnalyticsFilter,
    rollingWindow = 3
  ): Promise<CategoryTrendsReport> {
    const snapshot = await this.loadLedgerSnapshot(filter)
    return computeCategoryTrends(snapshot, filter, rollingWindow)
  }

  async getNetWorthProjection(
    filter: AnalyticsFilter,
    options: DebtPayoffOptions = { extraMonthlyMinor: 0, lumpSumMinor: 0, projectionMonths: 24 }
  ): Promise<NetWorthAndDebtReport> {
    const snapshot = await this.loadLedgerSnapshot(filter)
    return computeNetWorthAndDebt(snapshot, filter, options)
  }

  async listDrilldownTransactions(
    filter: AnalyticsFilter,
    criteria: DrilldownCriteria
  ): Promise<TransactionRecord[]> {
    const dateBounds = resolveDateBounds(filter)
    const tagMap = await this.loadTagMap()
    const { sql, params } = this.buildTransactionQuery(
      filter,
      dateBounds,
      criteria,
      !criteria.onlyTransfers
    )
    return this.queryTransactions(sql, params, tagMap)
  }

  private hydrateFallbackViewsFromStorage(): SavedAnalyticsView[] {
    if (!this.persistViewsToLocalStorageFallback || typeof window === 'undefined') return []
    try {
      const raw = window.localStorage.getItem(MEMORY_VIEWS_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as SavedAnalyticsView[]) : []
    } catch {
      return []
    }
  }

  private syncFallbackViewsToStorage(views: SavedAnalyticsView[]): void {
    if (!this.persistViewsToLocalStorageFallback || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(MEMORY_VIEWS_STORAGE_KEY, JSON.stringify(views))
    } catch {
      // Ignore storage quota errors in restricted contexts
    }
  }

  async listSavedViews(workspaceId?: string | null): Promise<SavedAnalyticsView[]> {
    const rows = workspaceId
      ? await this.db.select<Record<string, unknown>>(
          'SELECT _id, userId, workspaceId, name, chartTab, filterJson, isPinned, createdAt, updatedAt ' +
            'FROM saved_analytics_views WHERE deletedAt IS NULL AND workspaceId = ? ' +
            'ORDER BY isPinned DESC, updatedAt DESC',
          [workspaceId]
        )
      : await this.db.select<Record<string, unknown>>(
          'SELECT _id, userId, workspaceId, name, chartTab, filterJson, isPinned, createdAt, updatedAt ' +
            'FROM saved_analytics_views WHERE deletedAt IS NULL ' +
            'ORDER BY isPinned DESC, updatedAt DESC'
        )

    const dbViews: SavedAnalyticsView[] = rows.map((r) => ({
      id: String(r._id),
      userId: String(r.userId),
      workspaceId: r.workspaceId ? String(r.workspaceId) : null,
      name: String(r.name),
      chartTab: parseChartTab(r.chartTab),
      filter: JSON.parse(String(r.filterJson)) as AnalyticsFilter,
      isPinned: Number(r.isPinned ?? 0) !== 0,
      createdAt: String(r.createdAt),
      updatedAt: String(r.updatedAt),
    }))

    if (dbViews.length === 0 && this.persistViewsToLocalStorageFallback) {
      const cached = this.hydrateFallbackViewsFromStorage()
      for (const view of cached) {
        await this.insertOrUpdateViewRow(view)
      }
      return workspaceId
        ? cached.filter((v) => v.workspaceId === workspaceId)
        : cached
    }

    return dbViews
  }

  private async insertOrUpdateViewRow(view: SavedAnalyticsView): Promise<void> {
    await this.db.exec(
      'INSERT INTO saved_analytics_views ' +
        '(_id, userId, workspaceId, name, chartTab, filterJson, isPinned, createdAt, updatedAt, deletedAt) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ' +
        'ON CONFLICT(_id) DO UPDATE SET ' +
        'name = excluded.name, chartTab = excluded.chartTab, filterJson = excluded.filterJson, ' +
        'isPinned = excluded.isPinned, updatedAt = excluded.updatedAt, deletedAt = NULL',
      [
        view.id,
        view.userId,
        view.workspaceId,
        view.name,
        view.chartTab,
        JSON.stringify(view.filter),
        view.isPinned ? 1 : 0,
        view.createdAt,
        view.updatedAt,
      ]
    )
  }

  async saveView(view: SavedAnalyticsView): Promise<SavedAnalyticsView> {
    await this.insertOrUpdateViewRow(view)
    if (this.persistViewsToLocalStorageFallback) {
      const all = await this.listSavedViews(null)
      this.syncFallbackViewsToStorage(all)
    }
    return view
  }

  async deleteView(id: string): Promise<void> {
    await this.db.exec(
      "UPDATE saved_analytics_views SET deletedAt = 'deleted' WHERE _id = ?",
      [id]
    )
    if (this.persistViewsToLocalStorageFallback) {
      const all = await this.listSavedViews(null)
      this.syncFallbackViewsToStorage(all)
    }
  }
}
