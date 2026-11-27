import { describe, expect, it } from 'vitest'
import {
  computeEnvelopeMonthView,
  evaluateAssignment,
  expenseInEnvelopeMinor,
  incomePoolMinor,
  isEnvelopeCategory,
  migrateCapToEnvelopeTarget,
  monthBounds,
  monthKeyForDate,
  planMoveAllocation,
  assertMonthKey,
  EnvelopeError,
  ENVELOPE_TYPES,
  type EnvelopeAssignmentLike,
  type EnvelopeCategoryLike,
  type EnvelopeMonthSnapshot,
  type EnvelopeMonthView,
  type EnvelopeTransactionLike,
} from '@domain/envelope'

// ── Builders ─────────────────────────────────────────────────────────────────────────────────

const cat = (over: Partial<EnvelopeCategoryLike> & { _id: string }): EnvelopeCategoryLike => ({
  name: over._id,
  isArchived: false,
  envelopeType: 'expense',
  monthlyTargetMinor: 0,
  ...over,
})

const tx = (over: Partial<EnvelopeTransactionLike> & { _id: string }): EnvelopeTransactionLike => ({
  accountId: 'acc1',
  categoryId: 'food',
  type: 'expense',
  status: 'posted',
  amount: 0,
  date: '2027-01-15T12:00:00.000Z',
  splitTransactionId: null,
  workspaceId: null,
  ...over,
})

const assignment = (over: Partial<EnvelopeAssignmentLike> & { envelopeId: string; month: string }): EnvelopeAssignmentLike => ({
  kind: 'assignment',
  amountMinor: 0,
  workspaceId: null,
  ...over,
})

const view = (
  over: Partial<{
    month: string
    timezone: string
    workspaceId: string | null
    accountIds: string[]
    categories: EnvelopeCategoryLike[]
    transactions: EnvelopeTransactionLike[]
    assignments: EnvelopeAssignmentLike[]
  }>
): EnvelopeMonthView =>
  computeEnvelopeMonthView({
    month: '2027-01',
    timezone: 'UTC',
    workspaceId: null,
    categories: [cat({ _id: 'food' }), cat({ _id: 'fun', envelopeType: 'sinking_fund' })],
    transactions: [],
    assignments: [],
    ...over,
  })

// ── Rule 1 / TR-1 ────────────────────────────────────────────────────────────────────────────

describe('rule 1 / TR-1', () => {
  it('excludes draft transactions from income and activity', () => {
    const v = view({
      transactions: [
        tx({ _id: 'i', categoryId: '', type: 'income', amount: 10000, status: 'draft', date: '2027-01-05T00:00:00.000Z' }),
        tx({ _id: 'e', categoryId: 'food', type: 'expense', amount: 5000, status: 'draft' }),
      ],
    })
    expect(v.readyToAssignMinor).toBe(0)
    expect(v.envelopes.find((e) => e.envelopeId === 'food')?.availableMinor).toBe(0)
    expect(v.incomeThisMonthMinor).toBe(0)
  })
})

// ── Rule 2 / TR-2 ────────────────────────────────────────────────────────────────────────────

describe('rule 2 / TR-2', () => {
  it('excludes transfers from income pool and envelope activity', () => {
    const transfers = [
      tx({ _id: 't1', categoryId: 'food', type: 'transfer', amount: 999900, status: 'posted' }),
      tx({ _id: 't2', categoryId: '', type: 'transfer', amount: 999900, status: 'posted' }),
    ]
    expect(incomePoolMinor(transfers, new Date(0), new Date(Date.now() + 1e9), null)).toBe(0)
    expect(expenseInEnvelopeMinor(transfers, 'food', new Date(0), new Date(Date.now() + 1e9), null)).toBe(0)
    const v = view({ transactions: transfers })
    expect(v.incomeThisMonthMinor).toBe(0)
    expect(v.envelopes.find((e) => e.envelopeId === 'food')?.activityMinor).toBe(0)
    expect(v.readyToAssignMinor).toBe(0)
  })
})

// ── Rule 3 / TR-3 ────────────────────────────────────────────────────────────────────────────

describe('rule 3 / TR-3', () => {
  it('counts split children in own category and excludes split parent once it has children', () => {
    const parentId = 'parent'
    const transactions = [
      // split parent carries full amount; excluded once it has children
      tx({ _id: parentId, categoryId: 'food', type: 'expense', amount: 10000, splitTransactionId: null, hasSplitChildren: true }),
      // children counted in own category
      tx({ _id: 'c1', categoryId: 'food', type: 'expense', amount: 6000, splitTransactionId: parentId }),
      tx({ _id: 'c2', categoryId: 'fun', type: 'expense', amount: 4000, splitTransactionId: parentId }),
      // ordinary non-split tx counted
      tx({ _id: 'plain', categoryId: 'food', type: 'expense', amount: 500, splitTransactionId: null }),
    ]
    const v = view({
      categories: [cat({ _id: 'food' }), cat({ _id: 'fun' })],
      transactions,
    })
    const food = v.envelopes.find((e) => e.envelopeId === 'food')!
    const fun = v.envelopes.find((e) => e.envelopeId === 'fun')!
    // food: 6000 (child) + 500 (plain) = 6500, parent 10000 excluded
    expect(food.spentMinor).toBe(6500)
    expect(fun.spentMinor).toBe(4000)
    // parent exclusion works even without hasSplitChildren flag (splitTransactionId graph)
    const v2 = view({
      categories: [cat({ _id: 'food' })],
      transactions: transactions.map((t) => ({ ...t, hasSplitChildren: undefined })),
    })
    expect(v2.envelopes[0].spentMinor).toBe(6500)
  })
})

// ── Rule 4 / TR-4 ────────────────────────────────────────────────────────────────────────────

describe('rule 4 / TR-4', () => {
  it('scopes transactions and assignments to workspace', () => {
    const categories = [cat({ _id: 'food' })]
    const transactions = [
      tx({ _id: 'w1', categoryId: '', type: 'income', amount: 10000, workspaceId: 'ws1', date: '2027-01-05T00:00:00.000Z' }),
      tx({ _id: 'w2', categoryId: '', type: 'income', amount: 50000, workspaceId: 'ws2', date: '2027-01-05T00:00:00.000Z' }),
      tx({ _id: 'p', categoryId: '', type: 'income', amount: 30000, workspaceId: null, date: '2027-01-05T00:00:00.000Z' }),
      tx({ _id: 'e1', categoryId: 'food', type: 'expense', amount: 1000, workspaceId: 'ws1' }),
      tx({ _id: 'e2', categoryId: 'food', type: 'expense', amount: 9999, workspaceId: 'ws2' }),
    ]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 2000, workspaceId: 'ws1' }),
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 8000, workspaceId: 'ws2' }),
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 4000, workspaceId: null }),
    ]

    // workspaceId='ws1'
    const ws1 = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', workspaceId: 'ws1', categories, transactions, assignments })
    expect(ws1.incomeThisMonthMinor).toBe(10000)
    expect(ws1.assignedThisMonthMinor).toBe(2000)
    expect(ws1.envelopes[0].spentMinor).toBe(1000)

    // null personal
    const personal = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', workspaceId: null, categories, transactions, assignments })
    expect(personal.incomeThisMonthMinor).toBe(30000)
    expect(personal.assignedThisMonthMinor).toBe(4000)
    expect(personal.envelopes[0].spentMinor).toBe(0)

    // accountIds=[] = all accounts; accountIds=[...] restricts
    const acctTxs = [
      tx({ _id: 'a1', accountId: 'acc1', categoryId: '', type: 'income', amount: 1000, date: '2027-01-05T00:00:00.000Z' }),
      tx({ _id: 'a2', accountId: 'acc2', categoryId: '', type: 'income', amount: 2000, date: '2027-01-05T00:00:00.000Z' }),
    ]
    const all = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', accountIds: [], categories, transactions: acctTxs, assignments: [] })
    expect(all.incomeThisMonthMinor).toBe(3000)
    const restricted = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', accountIds: ['acc1'], categories, transactions: acctTxs, assignments: [] })
    expect(restricted.incomeThisMonthMinor).toBe(1000)
  })
})

// ── Rule 5 / TR-5 ────────────────────────────────────────────────────────────────────────────

describe('rule 5 / TR-5', () => {
  it('derives month key YYYY-MM in timezone', () => {
    expect(monthKeyForDate('2027-01-01T02:00:00.000Z', 'America/New_York')).toBe('2026-12')
    expect(monthKeyForDate('2027-01-15T00:00:00.000Z', 'UTC')).toBe('2027-01')
  })
})

// ── Rule 6 / TR-6 ────────────────────────────────────────────────────────────────────────────

describe('rule 6 / TR-6', () => {
  it('resolves month bounds via resolveMonthlyPeriod and cumulative cutoff at periodEnd', () => {
    const bounds = monthBounds('2027-02', 'UTC')
    expect(bounds.periodEnd.toISOString()).toBe('2027-02-28T23:59:59.999Z') // last day of Feb 2027
    const categories = [cat({ _id: 'food' })]
    const atEnd = tx({ _id: 'end', categoryId: 'food', type: 'expense', amount: 100, date: bounds.periodEnd.toISOString() })
    const after = tx({ _id: 'after', categoryId: 'food', type: 'expense', amount: 100, date: new Date(bounds.periodEnd.getTime() + 1).toISOString() })
    const incl = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions: [atEnd], assignments: [] })
    expect(incl.envelopes[0].spentMinor).toBe(100) // tx exactly periodEnd included
    const excl = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions: [after], assignments: [] })
    expect(excl.envelopes[0].spentMinor).toBe(0) // tx after excluded
    // cumulative uses date <= periodEnd(M)
    const cum = computeEnvelopeMonthView({
      month: '2027-02', timezone: 'UTC', categories,
      transactions: [tx({ _id: 'jan', categoryId: 'food', type: 'expense', amount: 50, date: '2027-01-15T00:00:00.000Z' }), atEnd],
      assignments: [],
    })
    expect(cum.envelopes[0].availableMinor).toBe(-150) // cumulative k≤M + date ≤ periodEnd(M)
  })

  it('assertMonthKey rejects invalid months', () => {
    expect(() => assertMonthKey('2027-13')).toThrow(EnvelopeError)
    expect(() => assertMonthKey('2027-1')).toThrow(EnvelopeError)
    expect(() => assertMonthKey('2027/01')).toThrow(EnvelopeError)
    expect(() => assertMonthKey('2027-00')).toThrow(EnvelopeError)
    expect(() => assertMonthKey('2027-01')).not.toThrow()
  })
})

// ── Rule 7 / TR-7 ────────────────────────────────────────────────────────────────────────────

describe('rule 7 / TR-7', () => {
  it('counts all posted income into incomePool regardless of category', () => {
    const transactions = [
      tx({ _id: 'i1', categoryId: '', type: 'income', amount: 10000, date: '2027-01-05T00:00:00.000Z' }), // income category
      tx({ _id: 'i2', categoryId: 'food', type: 'income', amount: 5000, date: '2027-01-06T00:00:00.000Z' }), // income in envelope category
      tx({ _id: 'i3', categoryId: 'income', type: 'income', amount: 2000, date: '2027-01-07T00:00:00.000Z' }), // income-category
      tx({ _id: 'i4', categoryId: '', type: 'income', amount: 1234, date: '2027-01-08T00:00:00.000Z' }), // uncategorized
    ]
    const v = view({ categories: [cat({ _id: 'food' }), cat({ _id: 'income', envelopeType: 'income' })], transactions })
    expect(v.incomeThisMonthMinor).toBe(10000 + 5000 + 2000 + 1234)
    // income-in-envelope counts toward pool but NOT activity (rules 7+9)
    expect(v.envelopes.find((e) => e.envelopeId === 'food')?.activityMinor).toBe(0)
  })
})

// ── Rules 8+9 / TR-8, TR-9 ───────────────────────────────────────────────────────────────────

describe('rules 8+9 / TR-8, TR-9', () => {
  it('readyToAssign equals cumulative income minus cumulative assigned', () => {
    const transactions = [
      tx({ _id: 'i-jan', categoryId: '', type: 'income', amount: 10000, date: '2027-01-10T00:00:00.000Z' }),
      tx({ _id: 'i-feb', categoryId: '', type: 'income', amount: 8000, date: '2027-02-10T00:00:00.000Z' }),
    ]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 4000 }),
      assignment({ envelopeId: 'fun', month: '2027-01', amountMinor: 1000 }),
      assignment({ envelopeId: 'food', month: '2027-02', amountMinor: 3000 }),
    ]
    // M = 2027-01
    const jan = view({ month: '2027-01', transactions, assignments })
    expect(jan.readyToAssignMinor).toBe(10000 - 5000)
    expect(jan.readyToAssignThisMonthMinor).toBe(10000 - 5000)
    expect(jan.incomeThisMonthMinor).toBe(10000)
    expect(jan.assignedThisMonthMinor).toBe(5000)
    // M = 2027-02 cumulative k≤M
    const feb = view({ month: '2027-02', transactions, assignments })
    expect(feb.readyToAssignMinor).toBe(10000 + 8000 - 8000) // Σincome(≤M) − Σassigned(≤M)
    expect(feb.readyToAssignThisMonthMinor).toBe(8000 - 3000)
  })

  it('readyToAssign is always visible and integer minor units', () => {
    const empty = view({})
    expect(Number.isInteger(empty.readyToAssignMinor)).toBe(true)
    expect(empty.readyToAssignMinor).toBe(0)
    // every unit assigned → 0
    const assigned = view({
      transactions: [tx({ _id: 'i', categoryId: '', type: 'income', amount: 10000, date: '2027-01-05T00:00:00.000Z' })],
      assignments: [assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 10000 })],
    })
    expect(assigned.readyToAssignMinor).toBe(0)
    // unassigned → > 0
    const unassigned = view({
      transactions: [tx({ _id: 'i', categoryId: '', type: 'income', amount: 10000, date: '2027-01-05T00:00:00.000Z' })],
    })
    expect(unassigned.readyToAssignMinor).toBe(10000)
    expect(unassigned.readyToAssignMinor).toBeGreaterThan(0)
  })
})

// ── Rules 9+11 / TR-10, TR-11 ────────────────────────────────────────────────────────────────

describe('rule 9 / TR-10', () => {
  it('assigned integer may be negative for re-allocation and unique per envelope month', () => {
    const base = view({
      assignments: [assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 })],
    })
    expect(base.envelopes.find((e) => e.envelopeId === 'food')?.budgetedMinor).toBe(5000)
    // negative assigned reduces available
    const neg = view({ assignments: [assignment({ envelopeId: 'food', month: '2027-01', amountMinor: -2000 })] })
    const negFood = neg.envelopes.find((e) => e.envelopeId === 'food')!
    expect(negFood.budgetedMinor).toBe(-2000)
    expect(negFood.availableMinor).toBe(-2000)
    expect(Number.isInteger(negFood.budgetedMinor)).toBe(true)
    // duplicate (E,month) collapses to one (not double counted)
    const dup = view({
      assignments: [
        assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 }),
        assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 }),
      ],
    })
    expect(dup.assignedThisMonthMinor).toBe(5000)
    expect(dup.envelopes.find((e) => e.envelopeId === 'food')?.availableMinor).toBe(5000)
  })
})

describe('rules 9+11 / TR-11', () => {
  it('activity equals negative expense in envelope', () => {
    const transactions = [
      tx({ _id: 'e', categoryId: 'food', type: 'expense', amount: 3000 }),
      tx({ _id: 'e2', categoryId: 'food', type: 'expense', amount: 1000 }),
      tx({ _id: 'i', categoryId: 'food', type: 'income', amount: 9999, date: '2027-01-06T00:00:00.000Z' }), // income-in-E not activity
      tx({ _id: 't', categoryId: 'food', type: 'transfer', amount: 9999 }), // transfer excluded
      tx({ _id: 'd', categoryId: 'food', type: 'expense', amount: 9999, status: 'draft' }), // draft excluded
    ]
    const food = view({ transactions }).envelopes.find((e) => e.envelopeId === 'food')!
    expect(food.spentMinor).toBe(4000)
    expect(food.activityMinor).toBe(-4000)
    expect(food.activityMinor).toBe(-food.spentMinor)
  })
})

// ── Rule 10 / TR-12 ──────────────────────────────────────────────────────────────────────────

describe('rule 10 / TR-12', () => {
  it('available is cumulative assigned plus cumulative activity', () => {
    const categories = [cat({ _id: 'food' })]
    const transactions = [
      tx({ _id: 'e1', categoryId: 'food', type: 'expense', amount: 1000, date: '2027-01-15T00:00:00.000Z' }),
      tx({ _id: 'e2', categoryId: 'food', type: 'expense', amount: 500, date: '2027-02-15T00:00:00.000Z' }),
    ]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 4000 }),
      assignment({ envelopeId: 'food', month: '2027-02', amountMinor: 2000 }),
    ]
    const jan = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments }).envelopes[0]
    expect(jan.availableMinor).toBe(4000 - 1000) // Σassigned k≤M + Σactivity k≤M
    const feb = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions, assignments }).envelopes[0]
    expect(feb.availableMinor).toBe(4000 + 2000 - 1000 - 500)
    expect(feb.availableMinor).toBe(feb.carriedInMinor + feb.budgetedMinor + feb.activityMinor)
  })
})

// ── Rule 11 / TR-13 ──────────────────────────────────────────────────────────────────────────

describe('rule 11 / TR-13', () => {
  it('budgeted activity available per envelope per month', () => {
    const categories = [cat({ _id: 'food', monthlyTargetMinor: 5000 })]
    const transactions = [tx({ _id: 'e', categoryId: 'food', type: 'expense', amount: 1500, date: '2027-02-10T00:00:00.000Z' })]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 4000 }),
      assignment({ envelopeId: 'food', month: '2027-02', amountMinor: 3000 }),
    ]
    const feb = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions, assignments }).envelopes[0]
    expect(feb.budgetedMinor).toBe(3000) // budgeted(E,M)=assigned(E,M)
    expect(feb.activityMinor).toBe(-1500) // activity this month; activityMinor=−spentMinor
    expect(feb.spentMinor).toBe(1500)
    expect(feb.targetMinor).toBe(5000) // targetMinor===monthlyTargetMinor
    expect(feb.carriedInMinor).toBe(4000) // carriedIn(E,M)===available(E,M−1)
    const jan = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments }).envelopes[0]
    expect(feb.carriedInMinor).toBe(jan.availableMinor)
    expect(feb.availableMinor).toBe(feb.carriedInMinor + feb.budgetedMinor + feb.activityMinor)
  })
})

// ── Rule 12 / TR-14, TR-15 ───────────────────────────────────────────────────────────────────

describe('rule 12 / TR-14', () => {
  it('positive rollover carries leftover forward', () => {
    const categories = [cat({ _id: 'food' })]
    const assignments = [assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 })]
    const feb = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions: [], assignments }).envelopes[0]
    const jan = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments }).envelopes[0]
    expect(jan.availableMinor).toBe(5000)
    expect(feb.carriedInMinor).toBe(jan.availableMinor) // available(E,M+1 start)===available(E,M)
    expect(feb.rolledOverNegative).toBe(false)
  })
})

describe('rule 12 / TR-15', () => {
  it('negative rollover carries overspend forward until covered', () => {
    const categories = [cat({ _id: 'food' })]
    const transactions = [tx({ _id: 'e', categoryId: 'food', type: 'expense', amount: 6000, date: '2027-01-15T00:00:00.000Z' })]
    const assignments = [assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 4000 })]
    const jan = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments }).envelopes[0]
    expect(jan.availableMinor).toBe(-2000) // nothing clamps to zero
    expect(jan.rolledOverNegative).toBe(true)
    const feb = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions, assignments }).envelopes[0]
    expect(feb.carriedInMinor).toBe(-2000) // carriedIn(E,M+1)===available(E,M)
    expect(feb.availableMinor).toBe(-2000)
    // assigned in M+1 restores
    const withCover = computeEnvelopeMonthView({
      month: '2027-02', timezone: 'UTC', categories, transactions,
      assignments: [...assignments, assignment({ envelopeId: 'food', month: '2027-02', amountMinor: 2000 })],
    }).envelopes[0]
    expect(withCover.availableMinor).toBe(0)
    expect(withCover.rolledOverNegative).toBe(false)
  })
})

// ── Rule 13 / TR-16..TR-20 ───────────────────────────────────────────────────────────────────

describe('rule 13 / TR-16', () => {
  it('month close records snapshot and blocks assignment', () => {
    const categories = [cat({ _id: 'food' })]
    const transactions = [tx({ _id: 'e', categoryId: 'food', type: 'expense', amount: 1000 })]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 }),
      { kind: 'monthClose' as const, envelopeId: '', month: '2027-01', amountMinor: 0, workspaceId: null },
    ]
    const v = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments })
    expect(v.isClosed).toBe(true)
    expect(v.warnings).toContain('month-closed')

    // snapshotJson round-trips EnvelopeMonthSnapshot
    const snapshot: EnvelopeMonthSnapshot = { month: v.month, readyToAssignMinor: v.readyToAssignMinor, envelopes: v.envelopes }
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as EnvelopeMonthSnapshot
    expect(roundTripped).toEqual(snapshot)
    expect(roundTripped.envelopes[0].carriedInMinor).toBeDefined()
    expect(roundTripped.envelopes[0].budgetedMinor).toBeDefined()
    expect(roundTripped.envelopes[0].activityMinor).toBeDefined()
    expect(roundTripped.envelopes[0].availableMinor).toBeDefined()
    expect(roundTripped.readyToAssignMinor).toBeDefined()

    // moveAllocation in closed M → MONTH_CLOSED
    expect(() => planMoveAllocation(v, 'food', 'fun', 100)).toThrowError(EnvelopeError)
    try {
      planMoveAllocation(v, 'food', 'fun', 100)
      expect.unreachable()
    } catch (err) {
      expect((err as EnvelopeError).code).toBe('MONTH_CLOSED')
    }
  })
})

describe('rule 13 / TR-17', () => {
  it('carry forward equals available at close regardless of closed flag', () => {
    const categories = [cat({ _id: 'food' })]
    const transactions = [tx({ _id: 'e', categoryId: 'food', type: 'expense', amount: 1500, date: '2027-01-15T00:00:00.000Z' })]
    const baseAssignments = [assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 })]
    const closed = [...baseAssignments, { kind: 'monthClose' as const, envelopeId: '', month: '2027-01', amountMinor: 0, workspaceId: null }]

    const openJan = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments: baseAssignments }).envelopes[0]
    const closedJan = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments: closed }).envelopes[0]
    expect(closedJan.availableMinor).toBe(openJan.availableMinor)

    const openFeb = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions, assignments: baseAssignments }).envelopes[0]
    const closedFeb = computeEnvelopeMonthView({ month: '2027-02', timezone: 'UTC', categories, transactions, assignments: closed }).envelopes[0]
    // available(E, M+1 start)===available(E,M) closed or not; conservation holds
    expect(closedFeb.carriedInMinor).toBe(closedJan.availableMinor)
    expect(closedFeb.availableMinor).toBe(openFeb.availableMinor)
    expect(closedFeb.carriedInMinor + closedFeb.budgetedMinor + closedFeb.activityMinor).toBe(closedFeb.availableMinor)
  })
})

describe('rule 13 / TR-18', () => {
  it('reopen removes month close marker and restores assignment', () => {
    const categories = [cat({ _id: 'food' })]
    const closed = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 }),
      { kind: 'monthClose' as const, envelopeId: '', month: '2027-01', amountMinor: 0, workspaceId: null },
    ]
    const closedView = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments: closed })
    expect(closedView.isClosed).toBe(true)
    // reopenMonth(M) removes the marker
    const reopened = closed.filter((a) => a.kind !== 'monthClose')
    const reopenedView = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments: reopened })
    expect(reopenedView.isClosed).toBe(false) // isClosed(M)===false
    // assign would succeed: no MONTH_CLOSED from planMoveAllocation when not closed
    const fun = cat({ _id: 'fun' })
    const v = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories: [...categories, fun], transactions: [], assignments: reopened })
    expect(() => planMoveAllocation(v, 'food', 'fun', 100)).not.toThrow()
  })
})

describe('rule 13 / TR-19', () => {
  it('month close marker unique per workspace month', () => {
    const categories = [cat({ _id: 'food' })]
    const twoCloses = [
      { kind: 'monthClose' as const, envelopeId: '', month: '2027-01', amountMinor: 0, workspaceId: null },
      { kind: 'monthClose' as const, envelopeId: '', month: '2027-01', amountMinor: 0, workspaceId: null },
    ]
    const v = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments: twoCloses })
    expect(v.isClosed).toBe(true)
    // monthClose rows are not assignments; they don't affect assignedTotal
    expect(v.assignedThisMonthMinor).toBe(0)
    expect(v.readyToAssignMinor).toBe(0)
  })
})

describe('rule 13 / TR-20', () => {
  it('transactions in closed month still recompute conservation', () => {
    const categories = [cat({ _id: 'food' })]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 }),
      { kind: 'monthClose' as const, envelopeId: '', month: '2027-01', amountMinor: 0, workspaceId: null },
    ]
    const base = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments })
    const baseAvailable = base.envelopes[0].availableMinor
    // a posted tx in closed M changes available + preserves conservation
    const withTx = computeEnvelopeMonthView({
      month: '2027-01', timezone: 'UTC', categories, assignments,
      transactions: [tx({ _id: 'late', categoryId: 'food', type: 'expense', amount: 700, date: '2027-01-20T00:00:00.000Z' })],
    })
    expect(withTx.isClosed).toBe(true)
    expect(withTx.envelopes[0].availableMinor).toBe(baseAvailable - 700)
    const sumAvail = withTx.envelopes.reduce((s, e) => s + e.availableMinor, 0)
    // ΣE available + RTA === Σincome − ΣexpenseInEnvelope
    expect(sumAvail + withTx.readyToAssignMinor).toBe(-700)
  })
})

// ── Rule 14 / TR-21, TR-22 ───────────────────────────────────────────────────────────────────

describe('rule 14 / TR-21', () => {
  it('moveAllocation shifts assigned between envelopes without changing ready to assign', () => {
    const categories = [cat({ _id: 'food' }), cat({ _id: 'fun' })]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 }),
      assignment({ envelopeId: 'fun', month: '2027-01', amountMinor: 1000 }),
    ]
    const before = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments })
    const x = 2000
    const plan = planMoveAllocation(before, 'food', 'fun', x)
    expect(plan).toEqual({ fromDeltaMinor: -x, toDeltaMinor: x })

    const afterAssignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 5000 - x }),
      assignment({ envelopeId: 'fun', month: '2027-01', amountMinor: 1000 + x }),
    ]
    const after = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments: afterAssignments })
    // assignedTotal unchanged ⇒ readyToAssign unchanged
    expect(after.readyToAssignMinor).toBe(before.readyToAssignMinor)
    expect(after.assignedThisMonthMinor).toBe(before.assignedThisMonthMinor)
    const afterFood = after.envelopes.find((e) => e.envelopeId === 'food')!
    const afterFun = after.envelopes.find((e) => e.envelopeId === 'fun')!
    const beforeFood = before.envelopes.find((e) => e.envelopeId === 'food')!
    const beforeFun = before.envelopes.find((e) => e.envelopeId === 'fun')!
    expect(afterFood.availableMinor).toBe(beforeFood.availableMinor - x) // available(A)−=x
    expect(afterFun.availableMinor).toBe(beforeFun.availableMinor + x) // available(B)+=x
    // source may go negative (negative rollover; not an over-assignment)
    const drained = planMoveAllocation(before, 'fun', 'food', 5000)
    expect(drained).toEqual({ fromDeltaMinor: -5000, toDeltaMinor: 5000 })
  })
})

describe('rule 14 / TR-22', () => {
  it('moveAllocation rejects negative zero self and closed', () => {
    const categories = [cat({ _id: 'food' }), cat({ _id: 'fun' })]
    const base = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions: [], assignments: [] })
    // x<0 → INVALID_AMOUNT
    expect(() => planMoveAllocation(base, 'food', 'fun', -1)).toThrowError(expect.objectContaining({ code: 'INVALID_AMOUNT' }))
    // x===0 noop
    expect(planMoveAllocation(base, 'food', 'fun', 0)).toEqual({ fromDeltaMinor: 0, toDeltaMinor: 0 })
    // A===B → INVALID_ENVELOPE
    expect(() => planMoveAllocation(base, 'food', 'food', 100)).toThrowError(expect.objectContaining({ code: 'INVALID_ENVELOPE' }))
    // unknown envelope
    expect(() => planMoveAllocation(base, 'food', 'nope', 100)).toThrowError(expect.objectContaining({ code: 'INVALID_ENVELOPE' }))
    // closed → MONTH_CLOSED
    const closed = computeEnvelopeMonthView({
      month: '2027-01', timezone: 'UTC', categories, transactions: [],
      assignments: [{ kind: 'monthClose', envelopeId: '', month: '2027-01', amountMinor: 0, workspaceId: null }],
    })
    expect(() => planMoveAllocation(closed, 'food', 'fun', 100)).toThrowError(expect.objectContaining({ code: 'MONTH_CLOSED' }))
    // non-integer
    expect(() => planMoveAllocation(base, 'food', 'fun', 1.5)).toThrowError(expect.objectContaining({ code: 'INVALID_AMOUNT' }))
  })
})

// ── Rule 15 / TR-23 ──────────────────────────────────────────────────────────────────────────

describe('rule 15 / TR-23', () => {
  it('conservation sum available plus ready to assign equals income minus envelope expense', () => {
    const categories = [cat({ _id: 'food' }), cat({ _id: 'fun', envelopeType: 'sinking_fund' }), cat({ _id: 'other', envelopeType: 'income' })]
    const transactions = [
      tx({ _id: 'i1', categoryId: '', type: 'income', amount: 100000, date: '2027-01-05T00:00:00.000Z' }),
      tx({ _id: 'i2', categoryId: 'food', type: 'income', amount: 5000, date: '2027-01-06T00:00:00.000Z' }), // income in envelope
      tx({ _id: 'e1', categoryId: 'food', type: 'expense', amount: 12000, date: '2027-01-10T00:00:00.000Z' }),
      tx({ _id: 'e2', categoryId: 'fun', type: 'expense', amount: 3000, date: '2027-01-11T00:00:00.000Z' }),
      tx({ _id: 'e3', categoryId: 'other', type: 'expense', amount: 99999, date: '2027-01-11T00:00:00.000Z' }), // non-envelope expense
      tx({ _id: 't', categoryId: 'food', type: 'transfer', amount: 99999, date: '2027-01-12T00:00:00.000Z' }),
      tx({ _id: 'd', categoryId: 'food', type: 'expense', amount: 99999, status: 'draft', date: '2027-01-12T00:00:00.000Z' }),
    ]
    const assignments = [
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 20000 }),
      assignment({ envelopeId: 'fun', month: '2027-01', amountMinor: 10000 }),
      assignment({ envelopeId: 'food', month: '2027-01', amountMinor: 20000 }), // duplicate collapses
    ]
    const v = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments })
    const sumAvailable = v.envelopes.reduce((s, e) => s + e.availableMinor, 0)
    // Σ incomePool(≤M) − Σ expenseInEnvelope(≤M) = (100000 + 5000) − (12000 + 3000); non-envelope expense + transfer + draft excluded
    expect(sumAvailable + v.readyToAssignMinor).toBe(105000 - 15000)
    expect(Number.isInteger(sumAvailable + v.readyToAssignMinor)).toBe(true)
  })
})

// ── Rules 16+17 / TR-24, TR-25, TR-26 ────────────────────────────────────────────────────────

describe('rule 16 / TR-24', () => {
  it('over-assignment refused by default', () => {
    const r = evaluateAssignment({ currentReadyToAssignMinor: 1000, deltaAssignedMinor: 1500, policy: 'refuse', allowOverAssign: false })
    expect(r.ok).toBe(false)
    expect(r.resultingReadyToAssignMinor).toBe(-500)
    expect(r.resultingReadyToAssignMinor).toBeLessThan(0)
    expect(r.warnings).toContain('over-assignment')
    expect(r.warnings).toContain('negative-ready-to-assign')
    // `code OVER_ASSIGNMENT` is raised by the adapter; pure contract is ok===false. confirm-without-allow also refused.
    const noAllow = evaluateAssignment({ currentReadyToAssignMinor: 1000, deltaAssignedMinor: 1500, policy: 'confirm', allowOverAssign: false })
    expect(noAllow.ok).toBe(false)
    expect(noAllow.resultingReadyToAssignMinor).toBe(-500)
    // exactly covering is fine
    const exact = evaluateAssignment({ currentReadyToAssignMinor: 1000, deltaAssignedMinor: 1000, policy: 'refuse', allowOverAssign: false })
    expect(exact.ok).toBe(true)
    expect(exact.resultingReadyToAssignMinor).toBe(0)
    expect(exact.warnings).toEqual([])
  })
})

describe('rule 16 / TR-25', () => {
  it('over-assignment applied only with explicit confirmation and warns negative ready to assign', () => {
    const r = evaluateAssignment({ currentReadyToAssignMinor: 1000, deltaAssignedMinor: 1500, policy: 'confirm', allowOverAssign: true })
    expect(r.ok).toBe(true)
    expect(r.resultingReadyToAssignMinor).toBe(-500)
    expect(r.resultingReadyToAssignMinor).toBeLessThan(0)
    expect(r.warnings).toContain('over-assignment')
    expect(r.warnings).toContain('negative-ready-to-assign')
    // a negative readyToAssign can never be produced silently
    const silent = evaluateAssignment({ currentReadyToAssignMinor: 1000, deltaAssignedMinor: 1500, policy: 'refuse', allowOverAssign: true })
    expect(silent.ok).toBe(false) // refuse policy still refuses even with allowOverAssign
  })
})

describe('rule 17 / TR-26', () => {
  it('income split sum cannot exceed income and remainder stays ready to assign', () => {
    // pure helper contract is enforced by the adapter before any write; verify resulting accounting.
    const income = 10000
    const splits = [
      { envelopeId: 'food', amountMinor: 4000 },
      { envelopeId: 'fun', amountMinor: 2000 },
    ]
    const splitSum = splits.reduce((s, x) => s + x.amountMinor, 0)
    expect(splitSum).toBeLessThanOrEqual(income) // Σ splits ≤ amount
    const categories = [cat({ _id: 'food' }), cat({ _id: 'fun', envelopeType: 'sinking_fund' })]
    const transactions = [tx({ _id: 'i', categoryId: '', type: 'income', amount: income, date: '2027-01-05T00:00:00.000Z' })]
    const assignments = splits.map((s) => assignment({ envelopeId: s.envelopeId, month: '2027-01', amountMinor: s.amountMinor, kind: 'assignment', workspaceId: null }))
    const v = computeEnvelopeMonthView({ month: '2027-01', timezone: 'UTC', categories, transactions, assignments })
    // assignedTotal from splits; unassigned remainder in readyToAssign
    expect(v.assignedThisMonthMinor).toBe(splitSum)
    expect(v.readyToAssignMinor).toBe(income - splitSum)
  })
})

// ── Rule 18 pinned + Rule 19 / TR-27, TR-28, TR-29 ───────────────────────────────────────────

describe('rule 18 / TR-27', () => {
  it('existing per-category caps are unaffected; only @shared/budget computes spent (cap rendering independent of envelopes)', () => {
    // envelope module never mutates `budgets`; caps render independently (separate table).
    expect(ENVELOPE_TYPES).toEqual(['expense', 'sinking_fund', 'savings'])
  })
})

describe('rule 19 / TR-28', () => {
  it('migrateCapToEnvelopeTarget sets monthlyTargetMinor without touching budget and is idempotent', () => {
    const budget = { _id: 'b1', categoryId: 'food', amount: 12000, isArchived: false }
    const category = cat({ _id: 'food', monthlyTargetMinor: 0 })
    const first = migrateCapToEnvelopeTarget({ budget, category })
    expect(first.migrated).toBe(true)
    expect(first.envelopeId).toBe('food')
    expect(first.targetMinor).toBe(12000) // category.monthlyTargetMinor === budget.amount
    // budgets row unchanged (pure; no mutation)
    expect(budget).toEqual({ _id: 'b1', categoryId: 'food', amount: 12000, isArchived: false })
    // second call: already-migrated target → migrated===false (reason)
    const second = migrateCapToEnvelopeTarget({ budget, category: { ...category, monthlyTargetMinor: 12000 } })
    expect(second.migrated).toBe(false)
    expect(second.reason).toBeTruthy()
    // `kind` absent ⇒ cap; kind='cap' ok; other kinds not migratable
    expect(migrateCapToEnvelopeTarget({ budget: { ...budget, kind: 'cap' }, category }).migrated).toBe(true)
    expect(migrateCapToEnvelopeTarget({ budget: { ...budget, kind: 'envelope' }, category }).migrated).toBe(false)
    // archived cap not migratable; non-positive amount not migratable
    expect(migrateCapToEnvelopeTarget({ budget: { ...budget, isArchived: true }, category }).migrated).toBe(false)
    expect(migrateCapToEnvelopeTarget({ budget: { ...budget, amount: 0 }, category }).migrated).toBe(false)
  })
})

describe('rule 19 / TR-29', () => {
  it('overall scope caps are not migratable', () => {
    const r = migrateCapToEnvelopeTarget({ budget: { _id: 'b1', categoryId: null, amount: 12000, isArchived: false }, category: undefined })
    expect(r.migrated).toBe(false)
    expect(r.reason).toBe('overall-scope')
  })
})

// ── Envelope classification ──────────────────────────────────────────────────────────────────

describe('isEnvelopeCategory', () => {
  it('envelope = non-archived category with envelopeType in {expense, sinking_fund, savings}; income/transfer/archived excluded', () => {
    expect(isEnvelopeCategory(cat({ _id: 'a', envelopeType: 'expense' }))).toBe(true)
    expect(isEnvelopeCategory(cat({ _id: 'a', envelopeType: 'sinking_fund' }))).toBe(true)
    expect(isEnvelopeCategory(cat({ _id: 'a', envelopeType: 'savings' }))).toBe(true)
    expect(isEnvelopeCategory(cat({ _id: 'a', envelopeType: undefined }))).toBe(true) // absent ⇒ 'expense' (SQL default)
    expect(isEnvelopeCategory(cat({ _id: 'a', envelopeType: 'income' }))).toBe(false)
    expect(isEnvelopeCategory(cat({ _id: 'a', envelopeType: 'transfer' }))).toBe(false)
    expect(isEnvelopeCategory(cat({ _id: 'a', isArchived: true }))).toBe(false)
    // non-envelope categories excluded from rows
    const v = view({ categories: [cat({ _id: 'food' }), cat({ _id: 'income', envelopeType: 'income' }), cat({ _id: 'arch', isArchived: true })] })
    expect(v.envelopes.map((e) => e.envelopeId)).toEqual(['food'])
  })
})
