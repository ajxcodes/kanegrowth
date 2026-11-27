/**
 * Envelope / zero-based budgeting — pure domain rule set.
 *
 * Hexagonal slice (mirrors `@domain/standaloneDemo` + `@ports/demoData` + `@adapters/demoData`):
 * this module is PURE. No imports from `platform/`, `adapters/`, `ports/`, `features/`, `app/`,
 * `ui/`; only `@shared/*`. All arithmetic is **integer minor units**; no floats; no rounding drift.
 *
 * The authoritative, human-readable rule set lives in `apps/web/src/domain/envelope-rule-set.md`.
 * Numbered rules below (1–19) match that document and are pinned by
 * `apps/web/src/domain/__tests__/envelope.test.ts`.
 *
 * ── Documented rule set ──────────────────────────────────────────────────────────────────────
 *
 * **Transaction counting (mirrors `@shared/budget` `computeBudgetSpentMinorPure`):**
 *  1. Only `status === 'posted'` transactions count; `'draft'` excluded. (TR-1)
 *  2. `type === 'transfer'` excluded from income **and** activity. (TR-2)
 *  3. Splitting: a split **child** counts in its own `categoryId`; its **split parent is excluded
 *     once it has children** (`splitTransactionId` graph; `hasSplitChildren`); an ordinary non-split
 *     transaction still counts. (TR-3)
 *  4. Workspace scope: transactions + assignments filtered to `workspaceId` (`null` = personal;
 *     `accountIds` empty = all accounts; `accountIds=[...]` restricts; `categories` are personal
 *     and not workspace-filtered). (TR-4)
 *
 * **Month + timezone (`@shared/timezone`, `@shared/budget`, `DEFAULT_TIMEZONE`):**
 *  5. `monthKey` = `'YYYY-MM'`. `monthKeyForDate(iso, timezone)` =
 *     `dateStringInTimezone(new Date(iso), timezone).slice(0,7)`. (TR-5)
 *  6. `monthBounds(monthKey, timezone)` = `resolveMonthlyPeriod(year, month, timezone)`.
 *     `income(M)` / `activity(M)` inside `[periodStart, periodEnd]`; cumulative sums cut off at
 *     `periodEnd(M)`. "Cumulative through end(M)" = sum over months `k ≤ M` plus transactions
 *     `date ≤ periodEnd(M)`. (TR-6)
 *
 * **Income pool → Ready to Assign:**
 *  7. `incomePool(k)` = Σ posted `type==='income'` in month `k`, **any category** (income in an
 *     envelope category still funds the pool; it does **not** also add to envelope activity). (TR-7)
 *  8. `readyToAssign(M)` = `Σ_{k≤M} incomePool(k) − Σ_{k≤M} assignedTotal(k)`.
 *     `readyToAssignThisMonth(M)` = `incomePool(M) − assignedTotal(M)`. `assignedTotal(month)` =
 *     Σ `amountMinor` over `kind='assignment'`. (TR-8, TR-9)
 *
 * **Envelope balances:**
 *  9. `assigned(E, M)` integer (may be negative for re-allocation); uniqueness per `(E, month)`.
 *     `activity(E, k)` = `− Σ expense in E in k`. Income-in-E counts toward `incomePool` (rule 7)
 *     but does **not** add to envelope activity; it is funded back via `assigned`. (TR-10, TR-11)
 * 10. `available(E, M)` (cumulative) = `Σ_{k≤M} assigned(E, k) + Σ_{k≤M} activity(E, k)`. (TR-12)
 * 11. `budgeted(E, M) = assigned(E, M)`; `activityThisMonth(E, M) = activity(E, M)`;
 *     `carriedIn(E, M) = available(E, M−1)`; `available = carriedIn + budgeted + activityThisMonth`;
 *     `activityMinor = −spentMinor`; `targetMinor = categories.monthlyTargetMinor`. (TR-13)
 * 12. **Rollover:** nothing clamps to zero. **Positive rollover** = leftover `available > 0` carries
 *     forward into `M+1`. **Negative rollover** = `available < 0` carries forward and reduces
 *     `M+1` availability until covered by future `assigned`; `rolledOverNegative = available < 0`.
 *     Existing `Budget.rollover` caps flag is unaffected; envelopes always roll. (TR-14, TR-15)
 * 13. **Month close:** a `kind='monthClose'` marker per `(workspaceId, month)`. `closeMonth(M)`
 *     requires nothing else; it records `closedAt` + an `EnvelopeMonthSnapshot` (per-envelope
 *     `carriedIn/budgeted/activity/available` + `readyToAssign`) in `snapshotJson` for audit;
 *     **carry-forward is derived**, so `available(E, M+1 start)` equals `available(E, M)` regardless
 *     of whether `M` is closed. `isClosed(M)` blocks `assign`/`moveAllocation` targeting `M`
 *     (`MONTH_CLOSED`); `reopenMonth(M)` removes the marker. Transactions in a closed month still
 *     recompute (conservation preserved); only assignment edits are locked. (TR-16..TR-20)
 * 14. **Re-allocation** `moveAllocation(A→B, M, x)` (`x ≥ 0` integer): `assigned(A,M) −= x`,
 *     `assigned(B,M) += x`. `assignedTotal` unchanged ⇒ `readyToAssign` unchanged;
 *     `available(A) −= x`, `available(B) += x`. Source may go negative (negative rollover; **not**
 *     an over-assignment). Rejected if `x < 0`, `A === B`, or `M` closed. `x === 0` noop.
 *     (TR-21, TR-22)
 * 15. **Conservation invariant** (pinned): `Σ_E available(E, M) + readyToAssign(M) = Σ_{k≤M}
 *     incomePool(k) − Σ_{k≤M} expenseInEnvelope(k)` where `expenseInEnvelope` counts posted
 *     expenses in envelope categories. (TR-23)
 *
 * **Over-assignment (AC3):**
 * 16. `assign(E, M, …)` computes current `readyToAssign(end M)` (before this change) then
 *     `resultingReadyToAssign = currentReadyToAssign − deltaAssignedTotal`. If
 *     `resultingReadyToAssign < 0`:
 *     - default `'refuse'` → `EnvelopeError` code `'OVER_ASSIGNMENT'`, **nothing written**; OR
 *     - `onOverAssignment: 'confirm'` + `allowOverAssign: true` → applied **with warning**
 *       `'over-assignment'` and `'negative-ready-to-assign'`.
 *     **A negative `readyToAssign` can never be produced without an explicit warning.**
 *     `moveAllocation` never changes `readyToAssign`. (TR-24, TR-25)
 * 17. `assigned` from `readyToAssign` cannot exceed available `readyToAssign` unless rule 16
 *     confirm path is taken. `assigned` inside `recordIncome` splits: `Σ splits ≤ incomeAmount`,
 *     validated before any write; remaining income stays in `readyToAssign`. (TR-26)
 *
 * **Cap coexistence + migration (AC5):**
 * 18. Existing `budgets` rows are **untouched**; legacy `kind` absent ⇒ cap;
 *     `listLocalBudgetsWithProgress` and `computeBudgetSpentMinorPure` keep working; caps render
 *     independently of envelope rows (separate table). (TR-27 + preserved `BudgetsPage.test.tsx`.)
 * 19. **`migrateCapToEnvelopeTarget(budgetId)`**: reads a legacy per-category cap
 *     (`budgets.categoryId != null`, `!isArchived`, `kind` absent/`'cap'`, `budget.amount > 0`;
 *     `LocalBudget.amount` integer minor), and **sets `categories.monthlyTargetMinor =
 *     budget.amount`** on that category (cap becomes envelope target). Does **not**
 *     delete/archive/modify the `budgets` row; does **not** create assignments; **idempotent**.
 *     Overall-scope caps (`categoryId == null`) or already-migrated targets return
 *     `migrated: false` with a `reason`. (TR-28, TR-29) `category.update` is queued for sync.
 */

import { resolveMonthlyPeriod } from '@shared/budget'
import { DEFAULT_TIMEZONE, dateStringInTimezone } from '@shared/timezone'

// ── Constants + error ────────────────────────────────────────────────────────────────────────

export const ENVELOPE_TYPES = ['expense', 'sinking_fund', 'savings'] as const
export type EnvelopeType = (typeof ENVELOPE_TYPES)[number]
export type EnvelopeAssignmentKind = 'assignment' | 'monthClose'
export type EnvelopeAssignmentSource = 'manual' | 'income_split' | 'reallocate' | 'month_close'
export type OverAssignmentPolicy = 'refuse' | 'confirm'
export type EnvelopeWarning = 'over-assignment' | 'negative-ready-to-assign' | 'negative-available' | 'month-closed'

export type EnvelopeErrorCode =
  | 'OVER_ASSIGNMENT'
  | 'MONTH_CLOSED'
  | 'INVALID_AMOUNT'
  | 'INVALID_ENVELOPE'
  | 'INVALID_MONTH'
  | 'SPLIT_SUM_EXCEEDS_INCOME'
  | 'UNKNOWN_ACCOUNT'
  | 'NOT_MIGRATABLE'
  | 'NOT_FOUND'

export class EnvelopeError extends Error {
  constructor(public code: EnvelopeErrorCode, message: string) {
    super(message)
    this.name = 'EnvelopeError'
  }
}

// ── Structural inputs (no platform types) ────────────────────────────────────────────────────

export interface EnvelopeCategoryLike {
  _id: string
  name: string
  isArchived: boolean
  envelopeType?: string
  monthlyTargetMinor?: number
}

export interface EnvelopeTransactionLike {
  _id: string
  accountId: string
  categoryId: string
  type: string
  status: string
  amount: number
  date: string
  splitTransactionId: string | null
  workspaceId?: string | null
  hasSplitChildren?: boolean
}

export interface EnvelopeAssignmentLike {
  kind: EnvelopeAssignmentKind
  envelopeId: string
  month: string
  amountMinor: number
  workspaceId?: string | null
}

// ── Outputs ──────────────────────────────────────────────────────────────────────────────────

export interface EnvelopeRow {
  envelopeId: string
  name: string
  envelopeType: EnvelopeType
  targetMinor: number
  budgetedMinor: number
  activityMinor: number
  spentMinor: number
  carriedInMinor: number
  availableMinor: number
  rolledOverNegative: boolean
}

export interface EnvelopeMonthSnapshot {
  month: string
  readyToAssignMinor: number
  envelopes: EnvelopeRow[]
}

export interface EnvelopeMonthView {
  month: string
  timezone: string
  isClosed: boolean
  readyToAssignMinor: number
  readyToAssignThisMonthMinor: number
  incomeThisMonthMinor: number
  assignedThisMonthMinor: number
  envelopes: EnvelopeRow[]
  warnings: EnvelopeWarning[]
}

// ── Month helpers ────────────────────────────────────────────────────────────────────────────

const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/

/** Validates `month` is `'YYYY-MM'` with a real month 1–12. Throws `EnvelopeError INVALID_MONTH`. */
export const assertMonthKey = (month: string): void => {
  const match = MONTH_KEY_PATTERN.exec(month)
  if (!match) {
    throw new EnvelopeError('INVALID_MONTH', `Invalid month key '${month}'; expected 'YYYY-MM'`)
  }
  const monthNumber = Number(match[2])
  if (monthNumber < 1 || monthNumber > 12) {
    throw new EnvelopeError('INVALID_MONTH', `Invalid month key '${month}'; month must be 1–12`)
  }
}

/** `monthKey` = `'YYYY-MM'`; `monthKeyForDate(iso, tz)` = `dateStringInTimezone(new Date(iso), tz).slice(0,7)`. (rule 5, TR-5) */
export const monthKeyForDate = (iso: string, timezone: string): string =>
  dateStringInTimezone(new Date(iso), timezone).slice(0, 7)

/** `monthBounds(monthKey, tz)` = `resolveMonthlyPeriod(year, month, tz)`. (rule 6, TR-6) */
export const monthBounds = (monthKey: string, timezone: string): { periodStart: Date; periodEnd: Date } => {
  assertMonthKey(monthKey)
  const [year, month] = monthKey.split('-').map(Number)
  return resolveMonthlyPeriod(year, month, timezone)
}

/** Previous `'YYYY-MM'` key (e.g. `'2027-01' → '2026-12'`). */
export const previousMonthKey = (monthKey: string): string => {
  assertMonthKey(monthKey)
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, 1))
  date.setUTCMonth(date.getUTCMonth() - 1)
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** Lexicographic comparison works for zero-padded `'YYYY-MM'`. */
const monthCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ── Envelope + transaction filtering ─────────────────────────────────────────────────────────

/** Envelope = non-archived category whose `envelopeType ∈ {expense, sinking_fund, savings}`. (§2.1)
 * `envelopeType` absent/`''` is treated as `'expense'` (SQL `NOT NULL DEFAULT 'expense'`, migration 0005).
 * `envelopeType='income' | 'transfer'` and archived categories are **not** envelopes. */
export const isEnvelopeCategory = (cat: EnvelopeCategoryLike): boolean => {
  if (cat.isArchived) return false
  const envelopeType = cat.envelopeType ?? 'expense'
  return (ENVELOPE_TYPES as readonly string[]).includes(envelopeType)
}

const workspaceMatch = (record: { workspaceId?: string | null }, workspaceId: string | null): boolean =>
  (record.workspaceId ?? null) === workspaceId

/** Posted, non-transfer; split children count; split parent excluded once it has children. (rules 1–3) */
const isCountable = (tx: EnvelopeTransactionLike, parentIds: Set<string>): boolean => {
  if (tx.status !== 'posted') return false
  if (tx.type === 'transfer') return false
  if (tx.splitTransactionId !== null) return true
  return !parentIds.has(tx._id) && tx.hasSplitChildren !== true
}

const txTime = (tx: EnvelopeTransactionLike): number | null => {
  const time = new Date(tx.date).getTime()
  return Number.isNaN(time) ? null : time
}

const inRange = (tx: EnvelopeTransactionLike, start: Date, end: Date): boolean => {
  const time = txTime(tx)
  if (time === null) return false
  return time >= start.getTime() && time <= end.getTime()
}

const buildSplitParentIds = (txs: EnvelopeTransactionLike[]): Set<string> => {
  const ids = new Set<string>()
  for (const tx of txs) {
    if (tx.splitTransactionId !== null && tx.splitTransactionId !== undefined) ids.add(tx.splitTransactionId)
  }
  return ids
}

// ── Pool + activity (integer minor) ──────────────────────────────────────────────────────────

/**
 * `incomePool` over `[start, end]` (inclusive): Σ posted `type==='income'`, **any category**,
 * workspace-scoped; transfers + drafts excluded; split-parent rule applied. (rules 1–4, 7; TR-1,2,3,4,7)
 */
export const incomePoolMinor = (
  txs: EnvelopeTransactionLike[],
  start: Date,
  end: Date,
  workspaceId?: string | null,
  accountIds?: string[]
): number => {
  const scope = workspaceId ?? null
  const accountSet = accountIds && accountIds.length > 0 ? new Set(accountIds) : null
  const parentIds = buildSplitParentIds(txs.filter((tx) => workspaceMatch(tx, scope)))
  return txs.reduce((sum, tx) => {
    if (tx.type !== 'income') return sum
    if (!workspaceMatch(tx, scope)) return sum
    if (accountSet && !accountSet.has(tx.accountId)) return sum
    if (!isCountable(tx, parentIds)) return sum
    if (!inRange(tx, start, end)) return sum
    return sum + tx.amount
  }, 0)
}

/**
 * Σ posted `type==='expense'` in `envelopeId` over `[start, end]` (inclusive), workspace-scoped;
 * transfers + drafts excluded; income-in-E **not** counted; split-parent rule applied.
 * `activity(E,k) = −expenseInEnvelopeMinor(...)`. (rules 1–4, 9, 11; TR-2,3,4,11)
 */
export const expenseInEnvelopeMinor = (
  txs: EnvelopeTransactionLike[],
  envelopeId: string,
  start: Date,
  end: Date,
  workspaceId?: string | null,
  accountIds?: string[]
): number => {
  const scope = workspaceId ?? null
  const accountSet = accountIds && accountIds.length > 0 ? new Set(accountIds) : null
  const parentIds = buildSplitParentIds(txs.filter((tx) => workspaceMatch(tx, scope)))
  return txs.reduce((sum, tx) => {
    if (tx.type !== 'expense') return sum
    if (tx.categoryId !== envelopeId) return sum
    if (!workspaceMatch(tx, scope)) return sum
    if (accountSet && !accountSet.has(tx.accountId)) return sum
    if (!isCountable(tx, parentIds)) return sum
    if (!inRange(tx, start, end)) return sum
    return sum + tx.amount
  }, 0)
}

// ── Assigned (kind='assignment') ─────────────────────────────────────────────────────────────

export interface AssignedEntry { envelopeId: string; month: string; amountMinor: number }

/**
 * Collapsed `assigned` list; kind='assignment' only; workspace-scoped; duplicate `(E, month)`
 * collapses to one (last wins; re-allocation **updates** the row). (rule 9; TR-10)
 */
const collapseAssignments = (assignments: EnvelopeAssignmentLike[], workspaceId: string | null): AssignedEntry[] => {
  const byKey = new Map<string, AssignedEntry>()
  for (const a of assignments) {
    if (a.kind !== 'assignment') continue
    if (!workspaceMatch(a, workspaceId)) continue
    byKey.set(`${a.envelopeId} ${a.month}`, { envelopeId: a.envelopeId, month: a.month, amountMinor: a.amountMinor })
  }
  return [...byKey.values()]
}

/** `assigned(E, M)` integer (may be negative). */
const assignedFor = (entries: AssignedEntry[], envelopeId: string, month: string): number =>
  entries.find((e) => e.envelopeId === envelopeId && e.month === month)?.amountMinor ?? 0

/** Cumulative `assigned(E, k≤upToMonth)`. */
const cumulativeAssigned = (entries: AssignedEntry[], envelopeId: string, upToMonth: string): number => {
  let total = 0
  for (const e of entries) {
    if (e.envelopeId !== envelopeId) continue
    if (monthCmp(e.month, upToMonth) <= 0) total += e.amountMinor
  }
  return total
}

// ── Core computation ─────────────────────────────────────────────────────────────────────────

/**
 * Pure per-month envelope view. `month` `'YYYY-MM'`; `timezone` default `DEFAULT_TIMEZONE`;
 * `workspaceId` `null` = personal. Cumulative through `periodEnd(M)`. (rules 1–19)
 */
export const computeEnvelopeMonthView = (input: {
  month: string
  timezone?: string
  workspaceId?: string | null
  accountIds?: string[]
  categories: EnvelopeCategoryLike[]
  transactions: EnvelopeTransactionLike[]
  assignments: EnvelopeAssignmentLike[]
}): EnvelopeMonthView => {
  const month = input.month
  assertMonthKey(month)
  const timezone = input.timezone ?? DEFAULT_TIMEZONE
  const workspaceId = input.workspaceId ?? null
  const { periodStart, periodEnd } = monthBounds(month, timezone)

  // Workspace scope (rule 4). `categories` are personal and not workspace-filtered.
  const scope = workspaceId
  const accountSet = input.accountIds && input.accountIds.length > 0 ? new Set(input.accountIds) : null
  const scopedTxs = input.transactions.filter((tx) => workspaceMatch(tx, scope) && (!accountSet || accountSet.has(tx.accountId)))
  const scopedAssignments = input.assignments.filter((a) => workspaceMatch(a, scope))
  const parentIds = buildSplitParentIds(scopedTxs)

  // Split-aware pool + activity use the *scoped* list; `parentIds` derived from scoped list.
  const countableTxs = scopedTxs.filter((tx) => isCountable(tx, parentIds))

  // ── Cumulative through periodEnd(M) ──────────────────────────────────────────────────────
  const incomeCumulativeMinor = countableTxs.reduce((sum, tx) => {
    if (tx.type !== 'income') return sum
    const time = txTime(tx)
    if (time === null || time > periodEnd.getTime()) return sum
    return sum + tx.amount
  }, 0)
  const incomeThisMonthMinor = countableTxs.reduce((sum, tx) => {
    if (tx.type !== 'income') return sum
    if (!inRange(tx, periodStart, periodEnd)) return sum
    return sum + tx.amount
  }, 0)

  const assignedEntries = collapseAssignments(scopedAssignments, workspaceId)

  // cumulative assignedTotal k ≤ M
  let assignedCumulativeMinor = 0
  let assignedThisMonthMinor = 0
  for (const e of assignedEntries) {
    if (monthCmp(e.month, month) <= 0) assignedCumulativeMinor += e.amountMinor
    if (e.month === month) assignedThisMonthMinor += e.amountMinor
  }

  const readyToAssignMinor = incomeCumulativeMinor - assignedCumulativeMinor
  const readyToAssignThisMonthMinor = incomeThisMonthMinor - assignedThisMonthMinor

  const isClosed = scopedAssignments.some((a) => a.kind === 'monthClose' && a.month === month)

  // ── Per-envelope rows ────────────────────────────────────────────────────────────────────
  const envelopes = input.categories.filter(isEnvelopeCategory)
  const rows: EnvelopeRow[] = envelopes.map((cat) => {
    const envelopeId = cat._id
    const envelopeType = (cat.envelopeType ?? 'expense') as EnvelopeType
    const targetMinor = Number.isFinite(cat.monthlyTargetMinor) ? Math.trunc(cat.monthlyTargetMinor as number) : 0

    const budgetedMinor = assignedFor(assignedEntries, envelopeId, month)

    const spentThisMonthMinor = countableTxs.reduce((sum, tx) => {
      if (tx.type !== 'expense' || tx.categoryId !== envelopeId) return sum
      if (!inRange(tx, periodStart, periodEnd)) return sum
      return sum + tx.amount
    }, 0)
    const activityMinor = spentThisMonthMinor === 0 ? 0 : -spentThisMonthMinor

    // cumulative through end(M)
    const assignedCumulativeEnvelope = cumulativeAssigned(assignedEntries, envelopeId, month)
    const spentCumulativeMinor = countableTxs.reduce((sum, tx) => {
      if (tx.type !== 'expense' || tx.categoryId !== envelopeId) return sum
      const time = txTime(tx)
      if (time === null || time > periodEnd.getTime()) return sum
      return sum + tx.amount
    }, 0)
    const availableMinor = assignedCumulativeEnvelope - spentCumulativeMinor

    // carriedIn(E, M) = available(E, M−1); since available = carriedIn + budgeted + activity, derive it.
    const carriedInMinor = availableMinor - budgetedMinor - activityMinor

    return {
      envelopeId,
      name: cat.name,
      envelopeType,
      targetMinor,
      budgetedMinor,
      activityMinor,
      spentMinor: spentThisMonthMinor,
      carriedInMinor,
      availableMinor,
      rolledOverNegative: availableMinor < 0,
    }
  })

  // ── Warnings ─────────────────────────────────────────────────────────────────────────────
  const warnings: EnvelopeWarning[] = []
  if (readyToAssignMinor < 0) {
    warnings.push('over-assignment', 'negative-ready-to-assign')
  }
  if (rows.some((row) => row.availableMinor < 0)) warnings.push('negative-available')
  if (isClosed) warnings.push('month-closed')

  return {
    month,
    timezone,
    isClosed,
    readyToAssignMinor,
    readyToAssignThisMonthMinor,
    incomeThisMonthMinor,
    assignedThisMonthMinor,
    envelopes: rows,
    warnings,
  }
}

// ── Over-assignment policy (rule 16; TR-24, TR-25) ───────────────────────────────────────────

/**
 * `resultingReadyToAssignMinor = currentReadyToAssignMinor − deltaAssignedMinor`. `ok` iff
 * `resulting ≥ 0`, OR `policy==='confirm' && allowOverAssign===true`. When `resulting < 0`,
 * warnings include `'over-assignment'` + `'negative-ready-to-assign'`. **A negative
 * `readyToAssign` can never be produced silently.**
 */
export const evaluateAssignment = (input: {
  currentReadyToAssignMinor: number
  deltaAssignedMinor: number
  policy: OverAssignmentPolicy
  allowOverAssign: boolean
}): { ok: boolean; resultingReadyToAssignMinor: number; warnings: EnvelopeWarning[] } => {
  const resultingReadyToAssignMinor = input.currentReadyToAssignMinor - input.deltaAssignedMinor
  if (resultingReadyToAssignMinor >= 0) {
    return { ok: true, resultingReadyToAssignMinor, warnings: [] }
  }
  const warnings: EnvelopeWarning[] = ['over-assignment', 'negative-ready-to-assign']
  const ok = input.policy === 'confirm' && input.allowOverAssign === true
  return { ok, resultingReadyToAssignMinor, warnings }
}

// ── Re-allocation (rule 14; TR-21, TR-22) ────────────────────────────────────────────────────

/**
 * Pure re-allocation `moveAllocation(A→B, M, x)`: `assigned(A,M)−=x`, `assigned(B,M)+=x`;
 * `readyToAssign` unchanged. Rejected if `x<0` → `INVALID_AMOUNT`; `A===B` → `INVALID_ENVELOPE`;
 * `M` closed → `MONTH_CLOSED`; `x===0` noop. Unknown envelope → `INVALID_ENVELOPE`.
 */
export const planMoveAllocation = (
  view: EnvelopeMonthView,
  fromEnvelopeId: string,
  toEnvelopeId: string,
  amountMinor: number
): { fromDeltaMinor: number; toDeltaMinor: number } => {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new EnvelopeError('INVALID_AMOUNT', `moveAllocation amount must be a non-negative integer; got ${amountMinor}`)
  }
  if (fromEnvelopeId === toEnvelopeId) {
    throw new EnvelopeError('INVALID_ENVELOPE', 'moveAllocation source and destination envelopes must differ')
  }
  if (view.isClosed) {
    throw new EnvelopeError('MONTH_CLOSED', `Month ${view.month} is closed`)
  }
  const ids = new Set(view.envelopes.map((row) => row.envelopeId))
  if (!ids.has(fromEnvelopeId) || !ids.has(toEnvelopeId)) {
    throw new EnvelopeError('INVALID_ENVELOPE', `Unknown envelope(s): ${fromEnvelopeId}, ${toEnvelopeId}`)
  }
  if (amountMinor === 0) return { fromDeltaMinor: 0, toDeltaMinor: 0 }
  return { fromDeltaMinor: -amountMinor, toDeltaMinor: amountMinor }
}

// ── Cap → envelope-target migration (rule 19; TR-28, TR-29) ──────────────────────────────────

export interface CapBudgetLike {
  _id: string
  categoryId: string | null
  amount: number
  isArchived: boolean
  kind?: string
}

/**
 * **`migrateCapToEnvelopeTarget`**: reads a legacy per-category cap (`budgets.categoryId != null`,
 * `!isArchived`, `kind` absent/`'cap'`, `budget.amount > 0`; `LocalBudget.amount` integer minor),
 * and **sets `categories.monthlyTargetMinor = budget.amount`** on that category (cap becomes
 * envelope target). Pure predicate; the adapter performs the `category.update`. Does **not**
 * delete/archive/modify the `budgets` row; does **not** create assignments; **idempotent**.
 * Overall-scope caps (`categoryId == null`) → `migrated:false, reason:'overall-scope'`; archived →
 * `'archived'`; `kind` not cap → `'not-a-cap'`; non-positive amount → `'non-positive-amount'`;
 * unknown category → `'unknown-category'`; already-migrated target → `'already-migrated'`.
 */
export const migrateCapToEnvelopeTarget = (input: {
  budget: CapBudgetLike
  category?: EnvelopeCategoryLike
}): { migrated: boolean; envelopeId?: string; targetMinor?: number; reason?: string } => {
  const { budget, category } = input
  if (budget.categoryId == null) return { migrated: false, reason: 'overall-scope' }
  if (budget.isArchived) return { migrated: false, reason: 'archived' }
  if (budget.kind != null && budget.kind !== 'cap') return { migrated: false, reason: 'not-a-cap' }
  if (!Number.isInteger(budget.amount) || budget.amount <= 0) return { migrated: false, reason: 'non-positive-amount' }
  if (!category || category._id !== budget.categoryId) return { migrated: false, reason: 'unknown-category' }
  if ((category.monthlyTargetMinor ?? 0) === budget.amount) return { migrated: false, reason: 'already-migrated' }
  return { migrated: true, envelopeId: budget.categoryId, targetMinor: budget.amount }
}
