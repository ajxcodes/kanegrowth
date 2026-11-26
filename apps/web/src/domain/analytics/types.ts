export type AccountGroup = 'banking' | 'investment' | 'cash' | 'credit' | 'loan'
export type EnvelopeType = 'income' | 'expense' | 'sinking_fund' | 'savings' | 'transfer'
export type TxType = 'income' | 'expense' | 'transfer'

export type DateRangePreset = 'this_month' | 'last_month' | 'ytd' | 'last_12_months' | 'custom'
export type AttributionMode = 'all' | 'shared' | 'individual'
export type FlowBasis = 'net' | 'gross'
export type PayoffStrategy = 'snowball' | 'avalanche'
export type AnalyticsChartTab = 'sankey' | 'trends' | 'net_worth'

export class InvalidFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidFilterError'
  }
}

export class NonAmortizingDebtError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonAmortizingDebtError'
  }
}

export interface AccountRecord {
  id: string
  name: string
  accountType: string
  accountGroup: AccountGroup
  currency: string
  currentBalanceMinor: number
  isLiability: boolean
  interestRateBps: number
  minimumPaymentMinor: number
}

export interface CategoryRecord {
  id: string
  name: string
  envelopeType: EnvelopeType
  monthlyTargetMinor: number
}

export interface TagRecord {
  id: string
  name: string
}

export interface MemberRecord {
  id: string
  name: string
  role: string
  color: string
}

export interface RecurringRuleRecord {
  id: string
  accountId: string
  categoryId: string
  txType: TxType
  amountMinor: number
  cadence: string
  isActive: boolean
}

export interface TransactionRecord {
  id: string
  accountId: string
  categoryId: string
  txType: TxType
  status: string
  amountMinor: number
  date: string
  description: string
  memberId: string | null
  isShared: boolean
  transferPairId: string | null
  hasSplitChildren: boolean
  splitTransactionId: string | null
  tagIds: string[]
}

export interface LedgerSnapshot {
  accounts: AccountRecord[]
  categories: CategoryRecord[]
  tags: TagRecord[]
  members: MemberRecord[]
  recurringRules: RecurringRuleRecord[]
  transactions: TransactionRecord[]
}

export interface AnalyticsFilter {
  dateRangePreset: DateRangePreset
  startDate: string | null
  endDate: string | null
  asOfDate: string
  accountIds: string[]
  categoryIds: string[]
  tagIds: string[]
  memberIds: string[]
  attributionMode: AttributionMode
  includeTransfers: boolean
  flowBasis: FlowBasis
  workspaceId: string | null
}

export interface SavedAnalyticsView {
  id: string
  userId: string
  workspaceId: string | null
  name: string
  chartTab: AnalyticsChartTab
  filter: AnalyticsFilter
  isPinned: boolean
  createdAt: string
  updatedAt: string
}

export interface DrilldownCriteria {
  categoryId: string | null
  period: string | null
  onlyTransfers: boolean
}

export type SankeyNodeKind =
  | 'income'
  | 'pool'
  | 'expense'
  | 'sinking_fund'
  | 'savings'
  | 'transfer'
  | 'surplus'
  | 'deficit'

export interface SankeyNode {
  id: string
  label: string
  tier: 0 | 1 | 2
  kind: SankeyNodeKind
  amountMinor: number
  sharePct: number
  txCount: number
  categoryId: string | null
  x: number
  y: number
  width: number
  height: number
}

export interface SankeyLink {
  id: string
  sourceId: string
  targetId: string
  amountMinor: number
  sharePct: number
  txCount: number
  categoryId: string | null
  flowKind: SankeyNodeKind
}

export interface CashFlowSankeyGraph {
  nodes: SankeyNode[]
  links: SankeyLink[]
  totalInflowMinor: number
  totalOutflowMinor: number
  netSavingsMinor: number
  excludedTransferMinor: number
}

export interface CategoryTrendPoint {
  period: string
  categoryId: string
  categoryName: string
  amountMinor: number
  rollingAvgMinor: number
  momDeltaMinor: number | null
  momDeltaPct: number | null
  priorYearAmountMinor: number | null
  yoyDeltaMinor: number | null
  yoyDeltaPct: number | null
  monthlyTargetMinor: number
  overageMinor: number
  isOverThreshold: boolean
  isAnomaly: boolean
  txCount: number
}

export interface CategoryTrendSummary {
  categoryId: string
  categoryName: string
  totalAmountMinor: number
  latestAmountMinor: number
  monthlyTargetMinor: number
  anomalyCount: number
  overageCount: number
}

export interface CategoryTrendsReport {
  periods: string[]
  series: CategoryTrendPoint[]
  summaries: CategoryTrendSummary[]
  rollingWindow: number
}

export interface NetWorthPoint {
  period: string
  assetsMinor: number
  liabilitiesMinor: number
  netWorthMinor: number
  byAccountGroup: Record<AccountGroup, number>
}

export interface DebtAccountInput {
  id: string
  name: string
  balanceMinor: number
  interestRateBps: number
  minimumPaymentMinor: number
}

export interface DebtPayoffOptions {
  extraMonthlyMinor: number
  lumpSumMinor: number
  projectionMonths: number
}

export interface DebtPayoffMonthPoint {
  monthIndex: number
  period: string
  remainingBalanceMinor: number
  interestPaidMinor: number
  principalPaidMinor: number
}

export interface DebtPayoffSummary {
  strategy: PayoffStrategy
  targetOrder: string[]
  debtFreeMonths: number
  debtFreeDate: string
  totalInterestPaidMinor: number
  totalPaidMinor: number
  baselineInterestMinor: number
  interestSavedVsMinimumMinor: number
  schedule: DebtPayoffMonthPoint[]
}

export interface DebtPayoffComparison {
  snowball: DebtPayoffSummary
  avalanche: DebtPayoffSummary
  interestSavedByAvalancheMinor: number
  extraPaymentInterestSavedMinor: number
}

export interface NetWorthAndDebtReport {
  timeline: NetWorthPoint[]
  projectionTimeline: NetWorthPoint[]
  snowball: DebtPayoffSummary
  avalanche: DebtPayoffSummary
  interestSavedByAvalancheMinor: number
  extraPaymentInterestSavedMinor: number
  warning: string | null
}
