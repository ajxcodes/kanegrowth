import type { OverAssignmentPolicy, EnvelopeMonthView, EnvelopeWarning } from '@domain/envelope'

/**
 * Hexagonal port for envelope / zero-based budgeting (mirrors `@ports/demoData/StandaloneDemoDataPort`).
 * Pure rule set lives in `@domain/envelope`; this port is the boundary to persistence + sync.
 * Imports `@domain/*` only. Adapter: `@adapters/envelope/SqliteEnvelopeLedgerAdapter`.
 */

export interface EnvelopeMonthQuery {
  month: string
  workspaceId?: string | null
  timezone?: string
  accountIds?: string[]
}

export interface AssignInput {
  workspaceId?: string | null
  userId: string
  envelopeId: string
  month: string
  /** Integer minor; **sets** `assigned(E, month)`; may be negative; re-allocation updates the row. */
  amountMinor: number
  note?: string
  source?: 'manual' | 'reallocate'
  onOverAssignment?: OverAssignmentPolicy
  allowOverAssign?: boolean
  timezone?: string
}

export interface MoveAllocationInput {
  workspaceId?: string | null
  userId: string
  fromEnvelopeId: string
  toEnvelopeId: string
  month: string
  /** `x ≥ 0` integer; `x===0` noop; `A===B`/closed rejected. */
  amountMinor: number
  timezone?: string
}

export interface RecordIncomeInput {
  workspaceId?: string | null
  userId: string
  /** Positive integer minor. */
  amountMinor: number
  accountId: string
  /** `'YYYY-MM-DD'`. */
  payDate: string
  employer?: string
  notes?: string
  incomeCategoryId?: string
  currency: string
  /** Optional one-step split across envelope/sinking-fund categories; `Σ splits ≤ amountMinor`. */
  splits?: { envelopeId: string; amountMinor: number }[]
  timezone?: string
}

export interface EnvelopeMutationResult {
  view: EnvelopeMonthView
  warnings: EnvelopeWarning[]
}

export interface MigrateCapResult {
  migrated: boolean
  budgetId: string
  envelopeId?: string
  targetMinor?: number
  reason?: string
}

export interface EnvelopeLedgerPort {
  getMonthView(query: EnvelopeMonthQuery): Promise<EnvelopeMonthView>
  assign(input: AssignInput): Promise<EnvelopeMutationResult>
  moveAllocation(input: MoveAllocationInput): Promise<EnvelopeMutationResult>
  closeMonth(input: { workspaceId?: string | null; userId: string; month: string; timezone?: string }): Promise<EnvelopeMutationResult>
  reopenMonth(input: { workspaceId?: string | null; userId: string; month: string; timezone?: string }): Promise<EnvelopeMutationResult>
  /** Explicit **Add Income / Paycheck**: one `type='income'` transaction + optional envelope splits, atomically. */
  recordIncome(input: RecordIncomeInput): Promise<EnvelopeMutationResult & { transactionId: string }>
  migrateCapToEnvelopeTarget(input: { budgetId: string; workspaceId?: string | null; userId: string }): Promise<MigrateCapResult>
}
