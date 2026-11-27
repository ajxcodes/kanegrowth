import {
  computeEnvelopeMonthView,
  evaluateAssignment,
  isEnvelopeCategory,
  migrateCapToEnvelopeTarget,
  monthKeyForDate,
  EnvelopeError,
  type EnvelopeAssignmentLike,
  type EnvelopeCategoryLike,
  type EnvelopeMonthSnapshot,
  type EnvelopeMonthView,
  type EnvelopeTransactionLike,
  type EnvelopeWarning,
} from '@domain/envelope'
import { recomputeLocalAccountBalance } from '@domain/accountBalances'
import type {
  LocalAccount,
  LocalBudget,
  LocalCategory,
  LocalEnvelopeAssignment,
  LocalTransaction,
} from '@domain/types'
import type { LocalDb, LocalDbRow } from '@platform/db/LocalDb'
import { generateLocalObjectId } from '@platform/db/generateLocalId'
import { Repository } from '@platform/db/repositories/Repository'
import { tableInvalidationBus } from '@lib/tableInvalidationBus'
import { DEFAULT_TIMEZONE } from '@shared/timezone'
import type {
  AssignInput,
  EnvelopeLedgerPort,
  EnvelopeMonthQuery,
  EnvelopeMutationResult,
  MigrateCapResult,
  MoveAllocationInput,
  RecordIncomeInput,
} from '@ports/envelope/EnvelopeLedgerPort'

/**
 * SQLite-backed implementation of `EnvelopeLedgerPort` over the existing `LocalDb` port.
 * **No SQL in React**; pure rules live in `@domain/envelope`. Writes happen in a single
 * `db.transaction(...)` (no nested `BEGIN`); outbox ops are enqueued inside the same transaction by
 * `Repository`. `tableInvalidationBus.publish(...)` fires after commit. Account balance is **derived**,
 * recomputed + persisted (`recomputeLocalAccountBalance`), never pushed through the outbox.
 * `recordIncome` does **not** apply `@domain/categorizationRules`.
 */
export class SqliteEnvelopeLedgerAdapter implements EnvelopeLedgerPort {
  private readonly accountsRepo = new Repository<LocalAccount>('accounts')
  private readonly categoriesRepo = new Repository<LocalCategory>('categories')
  private readonly transactionsRepo = new Repository<LocalTransaction>('transactions')
  private readonly budgetsRepo = new Repository<LocalBudget>('budgets')
  private readonly assignmentsRepo = new Repository<LocalEnvelopeAssignment>('envelopeAssignments')

  constructor(private readonly db: LocalDb) {}

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────

  async getMonthView(query: EnvelopeMonthQuery): Promise<EnvelopeMonthView> {
    const workspaceId = query.workspaceId ?? null
    const timezone = query.timezone ?? DEFAULT_TIMEZONE
    const [categories, transactions, assignments] = await Promise.all([
      this.listCategories(this.db),
      this.transactionsRepo.list(this.db),
      this.assignmentsRepo.list(this.db),
    ])
    return computeEnvelopeMonthView({
      month: query.month,
      timezone,
      workspaceId,
      accountIds: query.accountIds ?? [],
      categories,
      transactions: transactions.map(toEnvelopeTransactionLike),
      assignments: assignments.map(toEnvelopeAssignmentLike),
    })
  }

  // ── assign (rule 16; TR-24/25, TR-32/33) ────────────────────────────────────────────────────

  async assign(input: AssignInput): Promise<EnvelopeMutationResult> {
    const db = this.db
    const workspaceId = input.workspaceId ?? null
    const timezone = input.timezone ?? DEFAULT_TIMEZONE
    const month = input.month
    const amountMinor = input.amountMinor

    // Validation before any write.
    assertIntegerMinor(amountMinor)
    await this.assertMonthOpen(workspaceId, month)
    await this.assertEnvelope(db, input.envelopeId)

    // current readyToAssign(end M) before this change + previously assigned(E,M).
    const before = await this.getMonthView({ month, workspaceId, timezone })
    const currentAssigned = assignedOf(before, input.envelopeId)
    const deltaAssignedMinor = amountMinor - currentAssigned

    const evaluation = evaluateAssignment({
      currentReadyToAssignMinor: before.readyToAssignMinor,
      deltaAssignedMinor,
      policy: input.onOverAssignment ?? 'refuse',
      allowOverAssign: input.allowOverAssign ?? false,
    })
    if (!evaluation.ok) {
      throw new EnvelopeError(
        'OVER_ASSIGNMENT',
        `Assigning ${amountMinor} to ${input.envelopeId} in ${month} would produce negative readyToAssign ` +
          `(${evaluation.resultingReadyToAssignMinor}); confirm explicitly to override`
      )
    }

    await db.transaction(async (tx) => {
      await this.upsertAssignment(tx, {
        workspaceId,
        userId: input.userId,
        envelopeId: input.envelopeId,
        month,
        amountMinor,
        source: input.source ?? 'manual',
        note: input.note,
        currency: undefined,
      })
    })
    this.publish()

    const view = await this.getMonthView({ month, workspaceId, timezone })
    return { view, warnings: mergeWarnings(evaluation.warnings, view.warnings) }
  }

  // ── moveAllocation (rule 14; TR-21/22) ────────────────────────────────────────────────────

  async moveAllocation(input: MoveAllocationInput): Promise<EnvelopeMutationResult> {
    const db = this.db
    const workspaceId = input.workspaceId ?? null
    const timezone = input.timezone ?? DEFAULT_TIMEZONE
    const month = input.month
    const x = input.amountMinor

    assertIntegerMinor(x)
    if (x < 0) throw new EnvelopeError('INVALID_AMOUNT', `moveAllocation amount must be ≥ 0; got ${x}`)
    if (input.fromEnvelopeId === input.toEnvelopeId) {
      throw new EnvelopeError('INVALID_ENVELOPE', 'moveAllocation source and destination envelopes must differ')
    }
    await this.assertMonthOpen(workspaceId, month)
    await this.assertEnvelope(db, input.fromEnvelopeId)
    await this.assertEnvelope(db, input.toEnvelopeId)

    const before = await this.getMonthView({ month, workspaceId, timezone })

    if (x !== 0) {
      await db.transaction(async (tx) => {
        await this.adjustAssigned(tx, workspaceId, input.userId, input.fromEnvelopeId, month, -x)
        await this.adjustAssigned(tx, workspaceId, input.userId, input.toEnvelopeId, month, x)
      })
      this.publish()
    }

    const view = x === 0 ? before : await this.getMonthView({ month, workspaceId, timezone })
    return { view, warnings: view.warnings }
  }

  // ── month close / reopen (rule 13; TR-16..TR-20) ──────────────────────────────────────────

  async closeMonth(input: { workspaceId?: string | null; userId: string; month: string; timezone?: string }): Promise<EnvelopeMutationResult> {
    const db = this.db
    const workspaceId = input.workspaceId ?? null
    const timezone = input.timezone ?? DEFAULT_TIMEZONE
    const month = input.month

    // Snapshot the month BEFORE adding the marker.
    const snapshotView = await this.getMonthView({ month, workspaceId, timezone })
    const snapshot: EnvelopeMonthSnapshot = {
      month,
      readyToAssignMinor: snapshotView.readyToAssignMinor,
      envelopes: snapshotView.envelopes,
    }
    const closedAt = new Date().toISOString()
    const snapshotJson = JSON.stringify(snapshot)

    await db.transaction(async (tx) => {
      const existing = await this.findMonthClose(tx, workspaceId, month)
      const doc: LocalEnvelopeAssignment = {
        _id: existing?._id ?? generateLocalObjectId(),
        updatedAt: closedAt,
        userId: input.userId,
        workspaceId,
        kind: 'monthClose',
        envelopeId: '',
        month,
        amountMinor: 0,
        currency: '',
        source: 'month_close',
        snapshotJson,
        closedAt,
      }
      if (existing) {
        await this.assignmentsRepo.update(tx, doc, existing.updatedAt)
      } else {
        await this.assignmentsRepo.create(tx, doc)
      }
    })
    this.publish()

    const view = await this.getMonthView({ month, workspaceId, timezone })
    return { view, warnings: view.warnings }
  }

  async reopenMonth(input: { workspaceId?: string | null; userId: string; month: string; timezone?: string }): Promise<EnvelopeMutationResult> {
    const db = this.db
    const workspaceId = input.workspaceId ?? null
    const timezone = input.timezone ?? DEFAULT_TIMEZONE
    const month = input.month

    await db.transaction(async (tx) => {
      const existing = await this.findMonthClose(tx, workspaceId, month)
      if (existing) await this.assignmentsRepo.remove(tx, existing._id)
    })
    this.publish()

    const view = await this.getMonthView({ month, workspaceId, timezone })
    return { view, warnings: view.warnings }
  }

  // ── recordIncome (§2.5; TR-26, TR-34, TR-35) ───────────────────────────────────────────────

  async recordIncome(input: RecordIncomeInput): Promise<EnvelopeMutationResult & { transactionId: string }> {
    const db = this.db
    const workspaceId = input.workspaceId ?? null
    const timezone = input.timezone ?? DEFAULT_TIMEZONE

    // ── Validation before any write ──
    const amountMinor = input.amountMinor
    assertIntegerMinor(amountMinor)
    if (amountMinor <= 0) throw new EnvelopeError('INVALID_AMOUNT', `income amount must be positive; got ${amountMinor}`)

    const payDate = input.payDate
    const payDateMs = new Date(payDate).getTime()
    if (Number.isNaN(payDateMs)) throw new EnvelopeError('INVALID_MONTH', `Invalid pay date '${payDate}'`)
    const isoDate = new Date(payDateMs).toISOString()

    const month = monthKeyForDate(payDate, timezone)

    const account = await this.accountsRepo.findById(db, input.accountId)
    if (!account || account.isArchived) {
      throw new EnvelopeError('UNKNOWN_ACCOUNT', `Unknown account '${input.accountId}'`)
    }

    const categories = await this.listCategories(db)

    const incomeCategoryId = input.incomeCategoryId ?? ''
    if (incomeCategoryId !== '' && !categories.some((c) => c._id === incomeCategoryId)) {
      throw new EnvelopeError('INVALID_ENVELOPE', `Unknown income category '${incomeCategoryId}'`)
    }

    const splits = input.splits ?? []
    let splitSum = 0
    for (const split of splits) {
      assertIntegerMinor(split.amountMinor)
      if (split.amountMinor < 0) throw new EnvelopeError('INVALID_AMOUNT', `split amount must be ≥ 0; got ${split.amountMinor}`)
      const envelope = categories.find((c) => c._id === split.envelopeId)
      if (!envelope || !isEnvelopeCategory(envelope)) {
        throw new EnvelopeError('INVALID_ENVELOPE', `Unknown envelope '${split.envelopeId}'`)
      }
      splitSum += split.amountMinor
    }
    // Σ splits ≤ incomeAmount, validated before any write. (rule 17; TR-26)
    if (splitSum > amountMinor) {
      throw new EnvelopeError('SPLIT_SUM_EXCEEDS_INCOME', `split sum ${splitSum} exceeds income ${amountMinor}`)
    }

    await this.assertMonthOpen(workspaceId, month)

    // ── Single atomic transaction ──
    const transactionId = generateLocalObjectId()
    const nowIso = new Date().toISOString()
    const title = input.employer?.trim() || 'Income'
    const description = input.notes?.trim() || undefined
    const source = input.employer?.trim() || undefined
    const currency = input.currency

    const incomeTx: LocalTransaction = {
      _id: transactionId,
      updatedAt: nowIso,
      createdAt: nowIso,
      userId: input.userId,
      workspaceId,
      accountId: input.accountId,
      categoryId: incomeCategoryId,
      type: 'income',
      status: 'posted',
      amount: amountMinor,
      title,
      description,
      source,
      date: isoDate,
      clearedStatus: 'pending',
      splitTransactionId: null,
    }

    await db.transaction(async (tx) => {
      // 1. one `type='income'` `status='posted'` transaction; enqueue `transaction` create.
      await this.transactionsRepo.create(tx, incomeTx)

      // 2. recompute + persist account balance once (derived; not a sync op).
      await this.persistAccountBalance(tx, input.accountId)

      // 3. for each split line, upsert kind='assignment' source='income_split'.
      for (const split of splits) {
        await this.adjustAssigned(tx, workspaceId, input.userId, split.envelopeId, month, split.amountMinor, {
          source: 'income_split',
          linkedTransactionId: transactionId,
          currency,
        })
      }
    })

    // Publishes `transactions`, `accounts`, `envelopeAssignments`.
    tableInvalidationBus.publish('transactions')
    tableInvalidationBus.publish('accounts')
    tableInvalidationBus.publish('envelopeAssignments')

    const view = await this.getMonthView({ month, workspaceId, timezone })
    return { view, warnings: view.warnings, transactionId }
  }

  // ── migrateCapToEnvelopeTarget (rule 19; TR-28/29) ──────────────────────────────────────────

  async migrateCapToEnvelopeTarget(input: { budgetId: string; workspaceId?: string | null; userId: string }): Promise<MigrateCapResult> {
    const db = this.db
    const budget = await this.budgetsRepo.findById(db, input.budgetId)
    if (!budget) throw new EnvelopeError('NOT_FOUND', `Budget '${input.budgetId}' not found`)

    let category: EnvelopeCategoryLike | undefined
    let rawCategory: LocalCategory | null = null
    if (budget.categoryId != null) {
      rawCategory = await this.readCategory(db, budget.categoryId)
      if (rawCategory) {
        category = {
          _id: rawCategory._id,
          name: rawCategory.name,
          isArchived: rawCategory.isArchived,
          envelopeType: rawCategory.envelopeType,
          monthlyTargetMinor: rawCategory.monthlyTargetMinor,
        }
      }
    }

    const kind = (budget as { kind?: unknown }).kind
    const result = migrateCapToEnvelopeTarget({
      budget: { _id: budget._id, categoryId: budget.categoryId, amount: budget.amount, isArchived: budget.isArchived, kind: typeof kind === 'string' ? kind : undefined },
      category,
    })

    const base: MigrateCapResult = {
      migrated: result.migrated,
      budgetId: budget._id,
      envelopeId: result.envelopeId,
      targetMinor: result.targetMinor,
      reason: result.reason,
    }
    if (!result.migrated || !rawCategory || result.targetMinor === undefined) return base

    // set categories.monthlyTargetMinor = budget.amount; queue `category.update`; budgets row untouched.
    const updatedAt = new Date().toISOString()
    const existing = rawCategory
    await db.transaction(async (tx) => {
      await this.categoriesRepo.update(
        tx,
        { ...existing, monthlyTargetMinor: result.targetMinor, updatedAt },
        existing.updatedAt
      )
    })
    tableInvalidationBus.publish('categories')
    return base
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  /** Upsert single kind='assignment' row for `(workspaceId, envelopeId, month)`; `amountMinor` SET. */
  private async upsertAssignment(
    tx: LocalDb,
    fields: {
      workspaceId: string | null
      userId: string
      envelopeId: string
      month: string
      amountMinor: number
      source: LocalEnvelopeAssignment['source']
      note?: string
      currency?: string
      linkedTransactionId?: string | null
    }
  ): Promise<void> {
    const existing = await this.findAssignment(tx, fields.workspaceId, fields.envelopeId, fields.month)
    const nowIso = new Date().toISOString()
    const doc: LocalEnvelopeAssignment = {
      _id: existing?._id ?? generateLocalObjectId(),
      updatedAt: nowIso,
      userId: fields.userId,
      workspaceId: fields.workspaceId,
      kind: 'assignment',
      envelopeId: fields.envelopeId,
      month: fields.month,
      amountMinor: fields.amountMinor,
      currency: fields.currency ?? existing?.currency ?? '',
      source: fields.source,
      note: fields.note ?? existing?.note,
      linkedTransactionId: fields.linkedTransactionId ?? existing?.linkedTransactionId ?? null,
    }
    if (existing) {
      await this.assignmentsRepo.update(tx, doc, existing.updatedAt)
    } else {
      await this.assignmentsRepo.create(tx, doc)
    }
  }

  /** `assigned(E,M) += delta` preserving single-row uniqueness. */
  private async adjustAssigned(
    tx: LocalDb,
    workspaceId: string | null,
    userId: string,
    envelopeId: string,
    month: string,
    deltaMinor: number,
    opts?: { source: LocalEnvelopeAssignment['source']; linkedTransactionId?: string | null; currency?: string }
  ): Promise<void> {
    const existing = await this.findAssignment(tx, workspaceId, envelopeId, month)
    const current = existing?.amountMinor ?? 0
    await this.upsertAssignment(tx, {
      workspaceId,
      userId,
      envelopeId,
      month,
      amountMinor: current + deltaMinor,
      source: opts?.source ?? 'reallocate',
      linkedTransactionId: opts?.linkedTransactionId,
      currency: opts?.currency,
    })
  }

  private async findAssignment(
    db: LocalDb,
    workspaceId: string | null,
    envelopeId: string,
    month: string
  ): Promise<LocalEnvelopeAssignment | null> {
    const rows = await this.assignmentsRepo.list(db)
    return (
      rows.find(
        (a) =>
          a.kind === 'assignment' &&
          (a.workspaceId ?? null) === workspaceId &&
          a.envelopeId === envelopeId &&
          a.month === month
      ) ?? null
    )
  }

  private async findMonthClose(db: LocalDb, workspaceId: string | null, month: string): Promise<LocalEnvelopeAssignment | null> {
    const rows = await this.assignmentsRepo.list(db)
    return rows.find((a) => a.kind === 'monthClose' && (a.workspaceId ?? null) === workspaceId && a.month === month) ?? null
  }

  private async assertMonthOpen(workspaceId: string | null, month: string): Promise<void> {
    const closed = await this.findMonthClose(this.db, workspaceId, month)
    if (closed) throw new EnvelopeError('MONTH_CLOSED', `Month ${month} is closed`)
  }

  private async assertEnvelope(db: LocalDb, envelopeId: string): Promise<void> {
    const categories = await this.listCategories(db)
    const envelope = categories.find((c) => c._id === envelopeId)
    if (!envelope || !isEnvelopeCategory(envelope)) {
      throw new EnvelopeError('INVALID_ENVELOPE', `Unknown envelope '${envelopeId}'`)
    }
  }

  /** Recompute one account's balance from scratch and persist directly (derived; never pushed). */
  private async persistAccountBalance(db: LocalDb, accountId: string): Promise<void> {
    const account = await this.accountsRepo.findById(db, accountId)
    if (!account) throw new EnvelopeError('UNKNOWN_ACCOUNT', `Unknown account '${accountId}'`)
    const balance = await recomputeLocalAccountBalance(db, accountId)
    const updated: LocalAccount = { ...account, currentBalance: balance }
    await db.exec(`UPDATE accounts SET data = ?, currentBalance = ?, _localUpdatedAt = ? WHERE _id = ?`, [
      JSON.stringify(updated),
      balance,
      new Date().toISOString(),
      accountId,
    ])
  }

  private async listCategories(db: LocalDb): Promise<EnvelopeCategoryLike[]> {
    const rows = await db.select<CategoryRow>(
      `SELECT _id, name, isArchived, envelopeType, monthlyTargetMinor FROM categories WHERE deletedAt IS NULL`
    )
    return rows.map((row) => ({
      _id: row._id,
      name: row.name ?? '',
      isArchived: Number(row.isArchived) === 1,
      envelopeType: row.envelopeType ?? 'expense',
      monthlyTargetMinor: Number(row.monthlyTargetMinor ?? 0),
    }))
  }

  private async readCategory(db: LocalDb, id: string): Promise<LocalCategory | null> {
    const rows = await db.select<CategoryRow & { data: string }>(
      `SELECT _id, name, isArchived, envelopeType, monthlyTargetMinor, data FROM categories WHERE _id = ? AND deletedAt IS NULL`,
      [id]
    )
    const row = rows[0]
    if (!row) return null
    let parsed: Partial<LocalCategory> = {}
    try {
      parsed = JSON.parse(row.data) as Partial<LocalCategory>
    } catch {
      parsed = {}
    }
    return {
      ...parsed,
      _id: row._id,
      name: row.name ?? parsed.name ?? '',
      isArchived: Number(row.isArchived) === 1,
      envelopeType: row.envelopeType ?? 'expense',
      monthlyTargetMinor: Number(row.monthlyTargetMinor ?? 0),
      userId: parsed.userId ?? null,
      masterCategoryId: parsed.masterCategoryId ?? null,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }
  }

  private publish(): void {
    tableInvalidationBus.publish('envelopeAssignments')
  }
}

interface CategoryRow extends LocalDbRow {
  _id: string
  name: string
  isArchived: number
  envelopeType: string | null
  monthlyTargetMinor: number | null
}

const assertIntegerMinor = (value: number): void => {
  if (!Number.isInteger(value)) throw new EnvelopeError('INVALID_AMOUNT', `amountMinor must be an integer; got ${value}`)
}

const assignedOf = (view: EnvelopeMonthView, envelopeId: string): number =>
  view.envelopes.find((row) => row.envelopeId === envelopeId)?.budgetedMinor ?? 0

const mergeWarnings = (a: EnvelopeWarning[], b: EnvelopeWarning[]): EnvelopeWarning[] => [...new Set([...a, ...b])]

const toEnvelopeTransactionLike = (tx: LocalTransaction): EnvelopeTransactionLike => ({
  _id: tx._id,
  accountId: tx.accountId,
  categoryId: tx.categoryId ?? '',
  type: tx.type,
  status: tx.status,
  amount: tx.amount,
  date: tx.date,
  splitTransactionId: tx.splitTransactionId ?? null,
  workspaceId: tx.workspaceId ?? null,
  hasSplitChildren: tx.hasSplitChildren ?? false,
})

const toEnvelopeAssignmentLike = (a: LocalEnvelopeAssignment): EnvelopeAssignmentLike => ({
  kind: a.kind,
  envelopeId: a.envelopeId,
  month: a.month,
  amountMinor: a.amountMinor,
  workspaceId: a.workspaceId ?? null,
})
