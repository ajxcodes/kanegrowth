import { beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #18: the desktop (Tauri) client persists the server-signed offline session grant in the
// same OS keychain as the refresh token, via the fixed-entry `offline_grant_*` commands. On the
// web it stays in localStorage; the keychain is never touched there.

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invokeMock(...args),
}))

const isTauriRuntimeMock = vi.fn()
vi.mock('../isTauri', () => ({
    isTauriRuntime: () => isTauriRuntimeMock(),
}))

const { getStoredOfflineGrant, storeOfflineGrant } = await import('../offlineGrant')

describe('offlineGrant storage backend', () => {
    beforeEach(() => {
        invokeMock.mockReset()
        isTauriRuntimeMock.mockReset()
        localStorage.clear()
    })

    it('writes the grant to the OS keychain on desktop and never to localStorage', async () => {
        isTauriRuntimeMock.mockReturnValue(true)
        invokeMock.mockResolvedValueOnce(undefined)

        await storeOfflineGrant('grant-1')

        expect(invokeMock).toHaveBeenCalledWith('offline_grant_set', { value: 'grant-1' })
        expect(localStorage.getItem('kanegrowth_offline_grant')).toBeNull()
    })

    it('fails closed to null when the keychain read throws', async () => {
        isTauriRuntimeMock.mockReturnValue(true)
        invokeMock.mockRejectedValue(new Error('No secret service available'))
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        await expect(getStoredOfflineGrant()).resolves.toBeNull()

        consoleError.mockRestore()
    })

    it('storing an omitted grant leaves the existing grant intact', async () => {
        isTauriRuntimeMock.mockReturnValue(false)

        await storeOfflineGrant('grant-1')
        await storeOfflineGrant(undefined)

        await expect(getStoredOfflineGrant()).resolves.toBe('grant-1')
        expect(invokeMock).not.toHaveBeenCalled()
    })
})
