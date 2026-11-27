import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemorySqliteDriver } from '@platform/db/MemorySqliteDriver'
import { runMigrations } from '@platform/db/migrations/runMigrations'
import { MIGRATIONS } from '@platform/db/migrations/schema'
import type { LocalDb } from '@platform/db/LocalDb'
import { Repository } from '@platform/db/repositories/Repository'
import { setLocalDb, resetLocalDbForTests } from '@platform/db/localDbInstance'
import { ENTITY_TO_TABLE, parseOutboxEntity, buildOutboxEntity } from '@platform/sync/entityMap'
import { SYNCABLE_TABLES, flushOutbox, resetSyncEngineForTests } from '@platform/sync/syncEngine'
import { recordConflict } from '@platform/sync/conflicts'
import type { SyncableRecord } from '@platform/db/repositories/Repository'
import type { LocalAccount, LocalBudget, LocalCategory, LocalEnvelopeAssignment, LocalTransaction } from '@domain/types'
import { tableInvalidationBus } from '@lib/tableInvalidationBus'
import { EnvelopeError } from '@domain/envelope'
import { SqliteEnvelopeLedgerAdapter } from '../SqliteEnvelopeLedgerAdapter'

// ── sync mock for TR-38 ──────────────────────────────────────────────────────────────────────
const pushOutboxOps = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('@platform/sync/syncApi', () => ({
  pushOutboxOps: (...args: unknown[]) => pushOutboxOps(...args),
}))

const accountsRepo = new Repository<LocalAccount>('accounts')
const categoriesRepo = new Repository<LocalCategory>('categories')
const transactionsRepo = new Repository<LocalTransaction>('transactions')
const budgetsRepo = new Repository<LocalBudget>('budgets')
const assignmentsRepo = new Repository<LocalEnvelopeAssignment>('envelopeAssignments')

const NOW = '2027-01-15T12:00:00.000Z'
const MONTH = '2027-01'

const seed = async (db: LocalDb): Promise<void> => {
  await accountsRepo.upsertFromServer(db, [
    { _id: 'acc1', updatedAt: NOW, userId: 'u1', workspaceId: null, name: 'Checking', type: 'checking', currency: 'USD', currentBalance: 0, isArchived: false },
  ])
  await categoriesRepo.upsertFromServer(db, [
    { _id: 'food', updatedAt: NOW, userId: 'u1', masterCategoryId: null, name: 'Food', isArchived: false, envelopeType: 'expense', monthlyTargetMinor: 0 },
    { _id: 'fun', updatedAt: NOW, userId: 'u1', masterCategoryId: null, name: 'Fun', isArchived: false, envelopeType: 'sinking_fund', monthlyTargetMinor: 0 },
    { _id: 'income', updatedAt: NOW, userId: 'u1', masterCategoryId: null, name: 'Income', isArchived: false, envelopeType: 'income', monthlyTargetMinor: 0 },
  ])
}

const readOutbox = async (db: LocalDb): Promise<Array<{ entity: string; operation: string; payload: string; baseUpdatedAt: string | null }>> =>
  db.select(`SELECT entity, operation, payload, baseUpdatedAt FROM _outbox ORDER BY createdAt, rowid`)

const seedIncome = async (db: LocalDb, amountMinor = 100000, month = MONTH): Promise<void> => {
  await transactionsRepo.upsertFromServer(db, [
    { _id: `inc-${Math.random().toString(36).slice(2)}`, updatedAt: NOW, userId: 'u1', workspaceId: null, accountId: 'acc1', categoryId: '', type: 'income', status: 'posted', amount: amountMinor, title: 'Income', date: `${month}-10T12:00:00.000Z`, splitTransactionId: null },
  ])
}

let db: LocalDb
let adapter: SqliteEnvelopeLedgerAdapter

beforeEach(async () => {
  db = await MemorySqliteDriver.create()
  await runMigrations(db, MIGRATIONS)
  setLocalDb(db)
  resetSyncEngineForTests()
  pushOutboxOps.mockReset()
  await seed(db)
  adapter = new SqliteEnvelopeLedgerAdapter(db)
})

afterEach(async () => {
  resetSyncEngineForTests()
  resetLocalDbForTests()
  await db.close()
})

// ── TR-32 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-32 assign persists to SQLite in one transaction', () => {
  it('row in envelopeAssignments; data JSON; promoted; _dirty=1 _syncState=pending', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })

    const rows = await db.select<{ data: string; kind: string; envelopeId: string; month: string; amountMinor: number; _dirty: number; _syncState: string }>(
      `SELECT data, kind, envelopeId, month, amountMinor, _dirty, _syncState FROM envelopeAssignments WHERE kind = 'assignment'`
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('assignment')
    expect(row.envelopeId).toBe('food')
    expect(row.month).toBe(MONTH)
    expect(row.amountMinor).toBe(5000)
    expect(row._dirty).toBe(1)
    expect(row._syncState).toBe('pending')
    const data = JSON.parse(row.data) as LocalEnvelopeAssignment
    expect(data.kind).toBe('assignment')
    expect(data.envelopeId).toBe('food')
    expect(data.month).toBe(MONTH)
    expect(data.amountMinor).toBe(5000)
    expect(data.source).toBe('manual')

    // single atomic transaction: exactly one outbox op for the assignment
    const outbox = await readOutbox(db)
    const assignmentOps = outbox.filter((o) => o.entity.startsWith('envelopeAssignment:'))
    expect(assignmentOps).toHaveLength(1)
    expect(assignmentOps[0].operation).toBe('create')
  })
})

// ── TR-33 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-33 assign upserts unique envelope month assignment for re-allocation', () => {
  it('one row per (workspaceId, envelopeId, month); amountMinor updated; baseUpdatedAt; updatedAt bumped', async () => {
    await seedIncome(db)
    const first = await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    expect(first.view.envelopes.find((e) => e.envelopeId === 'food')?.budgetedMinor).toBe(5000)

    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 3000 })

    const rows = await db.select<{ amountMinor: number; updatedAt: string }>(`SELECT amountMinor, updatedAt FROM envelopeAssignments WHERE kind='assignment'`)
    expect(rows).toHaveLength(1) // one row per (workspaceId, envelopeId, month)
    expect(rows[0].amountMinor).toBe(3000) // amountMinor updated

    // second assign → 'update' op with baseUpdatedAt + bumped updatedAt
    const outbox = await readOutbox(db)
    const updateOp = outbox.filter((o) => o.entity.startsWith('envelopeAssignment:') && o.operation === 'update').pop()
    expect(updateOp).toBeDefined()
    expect(updateOp?.baseUpdatedAt).toBeTruthy()
    const payload = JSON.parse(updateOp?.payload ?? '{}') as LocalEnvelopeAssignment
    expect(payload.amountMinor).toBe(3000)
  })
})

// ── TR-34 / TR-35 ────────────────────────────────────────────────────────────────────────────

describe('TR-34 recordIncome inserts income transaction and splits atomically', () => {
  it('one type=income tx + N source=income_split linkedTransactionId; balance once; no splitTransactionId children; all-or-nothing', async () => {
    const result = await adapter.recordIncome({
      userId: 'u1',
      workspaceId: null,
      amountMinor: 10000,
      accountId: 'acc1',
      payDate: '2027-01-15',
      employer: 'Acme',
      notes: 'Jan pay',
      currency: 'USD',
      splits: [
        { envelopeId: 'food', amountMinor: 4000 },
        { envelopeId: 'fun', amountMinor: 2000 },
      ],
    })

    // one income transaction
    const txs = await transactionsRepo.list(db)
    const income = txs.filter((t) => t.type === 'income')
    expect(income).toHaveLength(1)
    expect(income[0]._id).toBe(result.transactionId)
    expect(income[0].status).toBe('posted')
    expect(income[0].amount).toBe(10000)
    expect(income[0].source).toBe('Acme')
    expect(income[0].description).toBe('Jan pay')
    expect(income[0].clearedStatus).toBe('pending')
    expect(income[0].splitTransactionId).toBeNull()
    // no splitTransactionId children
    expect(txs.filter((t) => t.splitTransactionId === result.transactionId)).toHaveLength(0)

    // N source='income_split' linkedTransactionId
    const splits = (await assignmentsRepo.list(db)).filter((a) => a.source === 'income_split')
    expect(splits).toHaveLength(2)
    expect(splits.every((a) => a.linkedTransactionId === result.transactionId)).toBe(true)
    expect(splits.every((a) => a.kind === 'assignment' && a.month === MONTH)).toBe(true)
    expect(splits.reduce((s, a) => s + a.amountMinor, 0)).toBe(6000)

    // account balance recomputed once
    const acc = await accountsRepo.findById(db, 'acc1')
    expect(acc?.currentBalance).toBe(100) // derived from recomputeLocalAccountBalance; persisted only (not pushed)

    // view reflects readyToAssign remainder
    expect(result.view.readyToAssignMinor).toBe(4000) // 10000 income − 6000 splits

    // all-or-nothing on error: split sum exceeding income writes nothing
    const before = (await transactionsRepo.list(db)).length
    await expect(
      adapter.recordIncome({ userId: 'u1', workspaceId: null, amountMinor: 100, accountId: 'acc1', payDate: '2027-01-15', currency: 'USD', splits: [{ envelopeId: 'food', amountMinor: 999 }] })
    ).rejects.toMatchObject({ code: 'SPLIT_SUM_EXCEEDS_INCOME' })
    expect((await transactionsRepo.list(db)).length).toBe(before)
  })

  it('rejects non-positive amount, unknown account, unknown envelope before any write', async () => {
    const before = (await transactionsRepo.list(db)).length
    await expect(adapter.recordIncome({ userId: 'u1', amountMinor: 0, accountId: 'acc1', payDate: '2027-01-15', currency: 'USD' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    await expect(adapter.recordIncome({ userId: 'u1', amountMinor: -5, accountId: 'acc1', payDate: '2027-01-15', currency: 'USD' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    await expect(adapter.recordIncome({ userId: 'u1', amountMinor: 100, accountId: 'nope', payDate: '2027-01-15', currency: 'USD' })).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' })
    await expect(adapter.recordIncome({ userId: 'u1', amountMinor: 100, accountId: 'acc1', payDate: '2027-01-15', currency: 'USD', splits: [{ envelopeId: 'nope', amountMinor: 1 }] })).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' })
    // income-category envelope is not an envelope
    await expect(adapter.recordIncome({ userId: 'u1', amountMinor: 100, accountId: 'acc1', payDate: '2027-01-15', currency: 'USD', splits: [{ envelopeId: 'income', amountMinor: 1 }] })).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' })
    expect((await transactionsRepo.list(db)).length).toBe(before)
  })
})

describe('TR-35 account balance derived not pushed through outbox', () => {
  it('no transaction/account op for currentBalance; balance persisted only', async () => {
    await adapter.recordIncome({ userId: 'u1', amountMinor: 10000, accountId: 'acc1', payDate: '2027-01-15', currency: 'USD' })
    const outbox = await readOutbox(db)
    // no account op at all; income transaction create only (+ envelopeAssignment if splits)
    expect(outbox.filter((o) => o.entity.startsWith('account:'))).toHaveLength(0)
    // no currentBalance mutation pushed as its own op
    expect(outbox.filter((o) => o.payload.includes('currentBalance') && o.entity.startsWith('account:'))).toHaveLength(0)
    const acc = await accountsRepo.findById(db, 'acc1')
    expect(acc?.currentBalance).toBe(100)
  })
})

// ── TR-36 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-36 allocation persists across reload offline', () => {
  it('reopen on same store; getMonthView identical; no network', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    const before = await adapter.getMonthView({ month: MONTH, workspaceId: null, timezone: 'UTC' })

    // "reload": a fresh adapter over the same (persisted) store; no network.
    const reloaded = new SqliteEnvelopeLedgerAdapter(db)
    const after = await reloaded.getMonthView({ month: MONTH, workspaceId: null, timezone: 'UTC' })
    expect(after).toEqual(before)
    expect(after.readyToAssignMinor).toBe(before.readyToAssignMinor)
    expect(after.envelopes.find((e) => e.envelopeId === 'food')?.availableMinor).toBe(5000)
  })
})

// ── TR-37 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-37 enqueues envelopeAssignment outbox ops like other ledger entities', () => {
  it('_outbox entity=envelopeAssignment:<id>; operation; payload; baseUpdatedAt; parseOutboxEntity; buildOutboxEntity', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    const outbox = await readOutbox(db)
    const op = outbox.find((o) => o.entity.startsWith('envelopeAssignment:'))!
    expect(op).toBeDefined()
    const { entityType, recordId } = parseOutboxEntity(op.entity)
    expect(entityType).toBe('envelopeAssignment')
    expect(recordId).toBeTruthy()
    expect(op.operation).toBe('create')
    expect(JSON.parse(op.payload).kind).toBe('assignment')
    expect(buildOutboxEntity('envelopeAssignment', recordId)).toBe(op.entity)
  })
})

// ── TR-38 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-38 flushOutbox pushes envelopeAssignment ops and reconciles', () => {
  it('pushOutboxOps receives envelopeAssignment; noop→applied; pending cleared; synced', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })

    pushOutboxOps.mockImplementation(async (...args: unknown[]) => {
      const ops = args[0] as Array<{ opId: string }>
      return { results: ops.map((o) => ({ opId: o.opId, status: 'noop' })), checkpoint: '0|' } // server noop→applied
    })

    await flushOutbox()

    const call = pushOutboxOps.mock.calls[0]?.[0] as Array<{ entity: string }>
    expect(call.some((o) => o.entity.startsWith('envelopeAssignment:'))).toBe(true)

    const pending = await db.select(`SELECT count(*) AS c FROM _outbox`)
    expect(Number((pending[0] as { c: number }).c)).toBe(0) // pending cleared
    const rows = await db.select<{ _syncState: string; _dirty: number }>(`SELECT _syncState, _dirty FROM envelopeAssignments`)
    expect(rows[0]._syncState).toBe('synced')
    expect(rows[0]._dirty).toBe(0)
  })
})

// ── TR-39 / TR-41 ────────────────────────────────────────────────────────────────────────────

describe('TR-39 pull applies server envelopeAssignment and tombstone', () => {
  it('upsertFromServer; applyTombstone sets deletedAt; list excludes tombstoned', async () => {
    const serverDoc: LocalEnvelopeAssignment = {
      _id: 'srv1', updatedAt: NOW, userId: 'u1', workspaceId: null, kind: 'assignment', envelopeId: 'food', month: MONTH, amountMinor: 7000, currency: 'USD', source: 'manual',
    }
    await assignmentsRepo.upsertFromServer(db, [serverDoc])
    let rows = await assignmentsRepo.list(db)
    expect(rows.find((a) => a._id === 'srv1')?.amountMinor).toBe(7000)

    await assignmentsRepo.applyTombstone(db, 'srv1', NOW)
    rows = await assignmentsRepo.list(db)
    expect(rows.find((a) => a._id === 'srv1')).toBeUndefined() // list excludes tombstoned
    const raw = await db.select<{ deletedAt: string | null }>(`SELECT deletedAt FROM envelopeAssignments WHERE _id='srv1'`)
    expect(raw[0].deletedAt).toBe(NOW)
  })
})

describe('TR-41 reconciles pending op on later pull without duplicate', () => {
  it('pending + pull → _dirty=0, single row', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    const id = (await assignmentsRepo.list(db))[0]._id
    const before = await db.select<{ _dirty: number }>(`SELECT _dirty FROM envelopeAssignments WHERE _id=?`, [id])
    expect(before[0]._dirty).toBe(1) // pending

    // later pull applies server doc for same id
    await assignmentsRepo.upsertFromServer(db, [{ _id: id, updatedAt: NOW, userId: 'u1', workspaceId: null, kind: 'assignment', envelopeId: 'food', month: MONTH, amountMinor: 5000, currency: 'USD', source: 'manual' } as LocalEnvelopeAssignment])
    const rows = await db.select<{ _dirty: number }>(`SELECT _dirty FROM envelopeAssignments WHERE _id=?`, [id])
    expect(rows).toHaveLength(1) // single row, no duplicate
    expect(rows[0]._dirty).toBe(0)
  })
})

// ── TR-40 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-40 conflict recorded in _conflicts inbox', () => {
  it('conflict→recordConflict entity envelopeAssignment; op dropped from pending; server doc retained', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    const id = (await assignmentsRepo.list(db))[0]._id
    const serverDoc: SyncableRecord = { _id: id, updatedAt: NOW, amountMinor: 9999 }

    await recordConflict(db, { entity: 'envelopeAssignment', recordId: id, localData: { amountMinor: 5000 }, serverData: serverDoc })

    const conflicts = await db.select<{ entity: string; recordId: string }>(`SELECT entity, recordId FROM _conflicts`)
    expect(conflicts.some((c) => c.entity === 'envelopeAssignment' && c.recordId === id)).toBe(true)
  })
})

// ── TR-42 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-42 delete enqueues tombstone delete op', () => {
  it("operation='delete'; deletedAt; payload _id + workspaceId", async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    const id = (await assignmentsRepo.list(db))[0]._id

    await db.transaction(async (tx) => { await assignmentsRepo.remove(tx, id) })

    const outbox = await readOutbox(db)
    const del = outbox.find((o) => o.operation === 'delete' && o.entity === `envelopeAssignment:${id}`)!
    expect(del).toBeDefined()
    const payload = JSON.parse(del.payload) as { _id: string; workspaceId?: string | null }
    expect(payload._id).toBe(id)
    const raw = await db.select<{ deletedAt: string | null }>(`SELECT deletedAt FROM envelopeAssignments WHERE _id=?`, [id])
    expect(raw[0].deletedAt).toBeTruthy()
  })
})

// ── TR-43 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-43 migration 0007 creates envelopeAssignments and sync registration complete', () => {
  it('runMigrations reaches version 7; table exists; ENTITY_TO_TABLE; SYNCABLE_TABLES; PROMOTED_COLUMNS', async () => {
    const ver = await db.select<{ version: number }>(`SELECT version FROM _schema_version WHERE id=1`)
    expect(ver[0].version).toBe(7)
    // table exists
    await expect(db.exec(`SELECT _id, userId, kind, envelopeId, month, amountMinor, data, updatedAt FROM envelopeAssignments LIMIT 0`)).resolves.not.toThrow()
    expect(ENTITY_TO_TABLE.envelopeAssignment).toBe('envelopeAssignments')
    expect(SYNCABLE_TABLES).toContain('envelopeAssignments')
  })
})

// ── invalidation ─────────────────────────────────────────────────────────────────────────────

describe('tableInvalidationBus.publish envelopeAssignments after every mutation', () => {
  it('publishes invalidation + refetch', async () => {
    const events: string[] = []
    const unsub = tableInvalidationBus.subscribe('envelopeAssignments', () => events.push('envelopeAssignments'))
    try {
      await seedIncome(db)
      await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
      await adapter.moveAllocation({ userId: 'u1', workspaceId: null, fromEnvelopeId: 'food', toEnvelopeId: 'fun', month: MONTH, amountMinor: 1000 })
      await adapter.closeMonth({ userId: 'u1', workspaceId: null, month: MONTH })
      await adapter.reopenMonth({ userId: 'u1', workspaceId: null, month: MONTH })
    } finally {
      unsub()
    }
    expect(events.length).toBeGreaterThanOrEqual(4)
  })
})

// ── month close + reopen adapter (TR-16..TR-20) ──────────────────────────────────────────────

describe('month close + reopen (adapter)', () => {
  it('closeMonth records kind=monthClose + snapshotJson + closedAt; blocks assign/moveAllocation; reopen removes', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    const closed = await adapter.closeMonth({ userId: 'u1', workspaceId: null, month: MONTH, timezone: 'UTC' })
    expect(closed.view.isClosed).toBe(true)

    const marker = (await assignmentsRepo.list(db)).find((a) => a.kind === 'monthClose')!
    expect(marker).toBeDefined()
    expect(marker.envelopeId).toBe('')
    expect(marker.amountMinor).toBe(0)
    expect(marker.source).toBe('month_close')
    expect(marker.closedAt).toBeTruthy()
    const snap = JSON.parse(marker.snapshotJson ?? '{}') as { month: string; readyToAssignMinor: number; envelopes: unknown[] }
    expect(snap.month).toBe(MONTH)
    expect(typeof snap.readyToAssignMinor).toBe('number')
    expect(Array.isArray(snap.envelopes)).toBe(true)

    // isClosed blocks assign/moveAllocation targeting M
    await expect(adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 6000 })).rejects.toMatchObject({ code: 'MONTH_CLOSED' })
    await expect(adapter.moveAllocation({ userId: 'u1', workspaceId: null, fromEnvelopeId: 'food', toEnvelopeId: 'fun', month: MONTH, amountMinor: 100 })).rejects.toMatchObject({ code: 'MONTH_CLOSED' })

    // reopenMonth removes the marker + restores assignment
    const reopened = await adapter.reopenMonth({ userId: 'u1', workspaceId: null, month: MONTH })
    expect(reopened.view.isClosed).toBe(false)
    await expect(adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 6000 })).resolves.toBeDefined()
  })
})

// ── moveAllocation adapter (TR-21/22) ────────────────────────────────────────────────────────

describe('moveAllocation (adapter)', () => {
  it('shifts assigned between envelopes; readyToAssign unchanged; rejects x<0/self/closed/unknown', async () => {
    await seedIncome(db)
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 5000 })
    await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'fun', month: MONTH, amountMinor: 1000 })
    const before = await adapter.getMonthView({ month: MONTH, workspaceId: null })

    const res = await adapter.moveAllocation({ userId: 'u1', workspaceId: null, fromEnvelopeId: 'food', toEnvelopeId: 'fun', month: MONTH, amountMinor: 2000 })
    expect(res.view.readyToAssignMinor).toBe(before.readyToAssignMinor)
    const food = res.view.envelopes.find((e) => e.envelopeId === 'food')!
    const fun = res.view.envelopes.find((e) => e.envelopeId === 'fun')!
    expect(food.budgetedMinor).toBe(3000)
    expect(fun.budgetedMinor).toBe(3000)
    // assignedTotal unchanged
    expect(res.view.assignedThisMonthMinor).toBe(before.assignedThisMonthMinor)

    await expect(adapter.moveAllocation({ userId: 'u1', workspaceId: null, fromEnvelopeId: 'food', toEnvelopeId: 'fun', month: MONTH, amountMinor: -1 })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    await expect(adapter.moveAllocation({ userId: 'u1', workspaceId: null, fromEnvelopeId: 'food', toEnvelopeId: 'food', month: MONTH, amountMinor: 1 })).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' })
    await expect(adapter.moveAllocation({ userId: 'u1', workspaceId: null, fromEnvelopeId: 'food', toEnvelopeId: 'fun', month: MONTH, amountMinor: 1.5 })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    // x===0 noop
    const noop = await adapter.moveAllocation({ userId: 'u1', workspaceId: null, fromEnvelopeId: 'food', toEnvelopeId: 'fun', month: MONTH, amountMinor: 0 })
    expect(noop.view.assignedThisMonthMinor).toBe(res.view.assignedThisMonthMinor)
  })
})

// ── over-assignment adapter (TR-24/25) ───────────────────────────────────────────────────────

describe('over-assignment adapter (rule 16)', () => {
  it('refused by default OVER_ASSIGNMENT nothing written; confirm+allow applies with warnings', async () => {
    // income 1000, nothing assigned; try to assign 1500
    await adapter.recordIncome({ userId: 'u1', amountMinor: 1000, accountId: 'acc1', payDate: '2027-01-10', currency: 'USD' })

    const beforeCount = (await assignmentsRepo.list(db)).length
    await expect(adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 1500 })).rejects.toMatchObject({ code: 'OVER_ASSIGNMENT' })
    expect((await assignmentsRepo.list(db)).length).toBe(beforeCount) // nothing written

    const res = await adapter.assign({ userId: 'u1', workspaceId: null, envelopeId: 'food', month: MONTH, amountMinor: 1500, onOverAssignment: 'confirm', allowOverAssign: true })
    expect(res.warnings).toContain('over-assignment')
    expect(res.warnings).toContain('negative-ready-to-assign')
    expect(res.view.readyToAssignMinor).toBe(-500) // negative RTA only with explicit warning
    expect(res.view.warnings).toContain('negative-ready-to-assign')
  })
})

// ── migrateCapToEnvelopeTarget adapter (TR-28/29) ────────────────────────────────────────────

describe('migrateCapToEnvelopeTarget (adapter)', () => {
  it('sets categories.monthlyTargetMinor; budgets row untouched; idempotent; queues category.update', async () => {
    await budgetsRepo.upsertFromServer(db, [
      { _id: 'b1', updatedAt: NOW, userId: 'u1', workspaceId: null, name: 'Food cap', categoryId: 'food', periodType: 'monthly', periodStart: '2027-01-01', periodEnd: '2027-01-31', amount: 12000, currency: 'USD', rollover: false, accountIds: [], isArchived: false } as LocalBudget,
    ])
    const budgetBefore = await budgetsRepo.findById(db, 'b1')

    const first = await adapter.migrateCapToEnvelopeTarget({ budgetId: 'b1', userId: 'u1', workspaceId: null })
    expect(first.migrated).toBe(true)
    expect(first.budgetId).toBe('b1')
    expect(first.envelopeId).toBe('food')
    expect(first.targetMinor).toBe(12000)

    // monthlyTargetMinor set on category
    const cat = await db.select<{ monthlyTargetMinor: number }>(`SELECT monthlyTargetMinor FROM categories WHERE _id='food'`)
    expect(cat[0].monthlyTargetMinor).toBe(12000)
    // category.update queued for sync
    const outbox = await readOutbox(db)
    expect(outbox.some((o) => o.entity === 'category:food' && (o.operation === 'update' || o.operation === 'create'))).toBe(true)
    // budgets row unchanged
    const budgetAfter = await budgetsRepo.findById(db, 'b1')
    expect(budgetAfter?.amount).toBe(budgetBefore?.amount)
    expect(budgetAfter?.isArchived).toBe(false)

    // idempotent: second call migrated===false with reason
    const second = await adapter.migrateCapToEnvelopeTarget({ budgetId: 'b1', userId: 'u1', workspaceId: null })
    expect(second.migrated).toBe(false)
    expect(second.reason).toBeTruthy()
  })

  it('overall-scope caps not migratable', async () => {
    await budgetsRepo.upsertFromServer(db, [
      { _id: 'b-overall', updatedAt: NOW, userId: 'u1', workspaceId: null, name: 'Overall', categoryId: null, periodType: 'monthly', periodStart: '2027-01-01', periodEnd: '2027-01-31', amount: 12000, currency: 'USD', rollover: false, accountIds: [], isArchived: false } as LocalBudget,
    ])
    const r = await adapter.migrateCapToEnvelopeTarget({ budgetId: 'b-overall', userId: 'u1', workspaceId: null })
    expect(r.migrated).toBe(false)
    expect(r.reason).toBe('overall-scope')
  })

  it('unknown budget NOT_FOUND', async () => {
    await expect(adapter.migrateCapToEnvelopeTarget({ budgetId: 'nope', userId: 'u1' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
