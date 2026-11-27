import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { MemorySqliteDriver } from '../../db/MemorySqliteDriver'
import { runMigrations } from '../../db/migrations/runMigrations'
import { MIGRATIONS } from '../../db/migrations/schema'
import { setLocalDb, resetLocalDbForTests } from '../../db/localDbInstance'
import type { LocalDb } from '../../db/LocalDb'

/**
 * AC2 (issue #18): a personal edit queued while offline survives an app restart and reconciles on
 * reconnect. "Restart" is simulated at the JS layer by snapshotting the durable tables, closing the
 * driver, opening a fresh one, and re-inserting the snapshot. The Tauri driver is file-backed, so
 * its own persistence contract is covered by `tauriSqlDriver.test.ts`; here we prove the outbox and
 * its transaction row are not lost between process lifetimes and flush once the network returns.
 */

const pushOutboxOps = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const runPullLoop = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})

vi.mock('../syncApi', () => ({
    pushOutboxOps: (...args: unknown[]) => pushOutboxOps(...args),
}))
vi.mock('../pullLoop', () => ({
    runPullLoop: (...args: unknown[]) => runPullLoop(...args),
}))

import { createOutbox } from '../outbox'
import { createSqliteOutboxStore } from '../sqliteOutboxStore'
import { getSyncStatus, resetSyncEngineForTests, syncNow } from '../syncEngine'

const setOnline = (online: boolean): void => {
    Object.defineProperty(navigator, 'onLine', { value: online, writable: true, configurable: true })
}

const OUTBOX_COLUMNS = [
    'opId',
    'entity',
    'operation',
    'payload',
    'baseUpdatedAt',
    'createdAt',
    'attempts',
    'lastError',
    'nextAttemptAt',
] as const

const TRANSACTION_COLUMNS = [
    '_id',
    'userId',
    'accountId',
    'categoryId',
    'type',
    'amount',
    'date',
    'data',
    'updatedAt',
    '_localUpdatedAt',
    '_dirty',
    '_syncState',
] as const

const snapshot = <T extends Record<string, unknown>>(db: LocalDb, table: string, columns: readonly string[]) =>
    db.select<T>(`SELECT ${columns.join(', ')} FROM ${table}`)

const restore = async (
    db: LocalDb,
    table: string,
    columns: readonly string[],
    rows: Array<Record<string, unknown>>
): Promise<void> => {
    for (const row of rows) {
        await db.exec(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
            columns.map((column) => row[column])
        )
    }
}

describe('offline relaunch (issue #18, AC2)', () => {
    let db: LocalDb

    beforeEach(async () => {
        setOnline(false)
        db = await MemorySqliteDriver.create()
        await runMigrations(db, MIGRATIONS)
        setLocalDb(db)
        resetSyncEngineForTests()
        pushOutboxOps.mockReset()
        runPullLoop.mockClear()
    })

    afterEach(async () => {
        resetSyncEngineForTests()
        resetLocalDbForTests()
        await db.close()
        setOnline(true)
    })

    it('a queued offline edit survives a restart and reconciles on reconnect', async () => {
        // Offline, queued as a personal edit (no `workspaceId`, the supported offline path).
        const outbox = createOutbox(createSqliteOutboxStore(db))
        const op = await outbox.enqueue({
            entity: 'transaction:txn-offline',
            operation: 'create',
            payload: {
                _id: 'txn-offline',
                userId: 'user1',
                accountId: 'acct1',
                categoryId: 'cat1',
                type: 'expense',
                amount: 4200,
                date: '2026-11-27',
            },
        })
        await db.exec(
            `INSERT INTO transactions
                (_id, userId, accountId, categoryId, type, amount, date, data, updatedAt, _localUpdatedAt, _dirty, _syncState)
             VALUES ('txn-offline', 'user1', 'acct1', 'cat1', 'expense', 4200, '2026-11-27', '{}',
                     '2026-11-27T00:00:00.000Z', '2026-11-27T00:00:00.000Z', 1, 'pending')`
        )

        // Simulated restart: snapshot the durable tables, close, reopen, re-insert.
        const outboxRows = await snapshot(db, '_outbox', OUTBOX_COLUMNS)
        const transactionRows = await snapshot(db, 'transactions', TRANSACTION_COLUMNS)
        await db.close()

        db = await MemorySqliteDriver.create()
        await runMigrations(db, MIGRATIONS)
        await restore(db, '_outbox', OUTBOX_COLUMNS, outboxRows)
        await restore(db, 'transactions', TRANSACTION_COLUMNS, transactionRows)
        setLocalDb(db)
        resetSyncEngineForTests()

        expect((await getSyncStatus()).pendingCount).toBe(1)

        // Reconnect: the queued op flushes and the local row is marked synced.
        setOnline(true)
        pushOutboxOps.mockResolvedValue({
            results: [{ opId: op.opId, status: 'applied', resultId: 'srv-txn-offline' }],
            checkpoint: 'c1',
        })

        await syncNow()

        expect(pushOutboxOps).toHaveBeenCalledTimes(1)
        const pushedOps = pushOutboxOps.mock.calls[0][0] as Array<{ opId: string }>
        expect(pushedOps.map((pending) => pending.opId)).toEqual([op.opId])
        expect((await getSyncStatus()).pendingCount).toBe(0)
        expect(runPullLoop).toHaveBeenCalled()

        const localRows = await db.select<{ _dirty: number; _syncState: string }>(
            'SELECT _dirty, _syncState FROM transactions'
        )
        expect(localRows).toEqual([{ _dirty: 0, _syncState: 'synced' }])
    })
})
