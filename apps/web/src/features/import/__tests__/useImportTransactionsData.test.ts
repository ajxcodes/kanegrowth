import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useImportTransactionsData } from '../hooks/useImportTransactionsData'

vi.mock('@lib/localFirstFlag', () => ({
    isLocalFirstEnabled: () => true,
}))

const { commitLocalImportMock, emitNotificationEventMock } = vi.hoisted(() => ({
    commitLocalImportMock: vi.fn(),
    emitNotificationEventMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@domain/importTransactions', () => ({
    parseLocalImportFile: vi.fn(),
    previewLocalImport: vi.fn(),
    commitLocalImport: commitLocalImportMock,
}))

vi.mock('@platform/db/localDbInstance', () => ({
    getLocalDb: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/app/providers/useUser', () => ({
    useUser: () => ({ user: { _id: 'user1', fullName: 'Jamie Rivera', email: 'jamie@example.com' } }),
}))

vi.mock('@lib/tableInvalidationBus', () => ({
    tableInvalidationBus: { publish: vi.fn() },
}))

vi.mock('@features/notifications/api', () => ({
    emitNotificationEvent: emitNotificationEventMock,
}))

const commitResult = {
    imported: 2,
    merged: 0,
    skipped: 0,
    transactionIds: ['tx-1', 'tx-2'],
    mergedTransactionIds: [],
    summary: {
        total: 2,
        valid: 2,
        invalid: 0,
        duplicates: 0,
        incomeTotal: 0,
        expenseTotal: 200,
    },
}

beforeEach(() => {
    commitLocalImportMock.mockResolvedValue(commitResult)
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('useImportTransactionsData', () => {
    it('emits an import completion event after a local commit', async () => {
        const { result } = renderHook(() => useImportTransactionsData())

        let committed: Awaited<ReturnType<typeof result.current.commitImport>> | undefined
        await act(async () => {
            committed = await result.current.commitImport({
                accountId: 'acc-1',
                defaultCategoryId: 'cat-1',
            })
        })

        expect(committed?.imported).toBe(2)
        expect(emitNotificationEventMock).toHaveBeenCalledTimes(1)
        expect(emitNotificationEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'import_completed',
                metadata: { imported: 2 },
            })
        )
    })
})
