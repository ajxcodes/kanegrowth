import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDb } from '../LocalDb'

vi.mock('@lib/localFirstFlag', () => ({ isLocalFirstEnabled: vi.fn() }))
vi.mock('@lib/localPinFlag', () => ({ isLocalPinEnabled: vi.fn() }))
vi.mock('@lib/standaloneLocalFlag', () => ({ isStandaloneLocalEnabled: vi.fn() }))
vi.mock('@lib/isTauri', () => ({ isTauriRuntime: vi.fn() }))

const wasmCreate = vi.fn()
vi.mock('../SqliteWasmDriver', () => ({
  SqliteWasmDriver: { create: (...args: unknown[]) => wasmCreate(...args) },
}))

const ensureStandaloneDemoSeedMock = vi.fn()
vi.mock('../repositories/analyticsSeed', () => ({
  ensureStandaloneDemoSeed: (...args: unknown[]) => ensureStandaloneDemoSeedMock(...args),
}))

const { isLocalFirstEnabled } = await import('@lib/localFirstFlag')
const { isLocalPinEnabled } = await import('@lib/localPinFlag')
const { isStandaloneLocalEnabled } = await import('@lib/standaloneLocalFlag')
const { isTauriRuntime } = await import('@lib/isTauri')
const { bootstrapLocalDb } = await import('../bootstrapLocalDb')
const { getLocalDb, resetLocalDbForTests } = await import('../localDbInstance')

const fakeDb = (): LocalDb => ({
  exec: vi.fn().mockResolvedValue(undefined),
  select: vi.fn().mockResolvedValue([]),
  transaction: vi.fn(async (fn) =>
    fn({ exec: vi.fn(), select: vi.fn(), transaction: vi.fn(), close: vi.fn() })
  ),
  close: vi.fn(),
})

describe('bootstrapLocalDb standalone demo seed gate', () => {
  beforeEach(() => {
    resetLocalDbForTests()
    wasmCreate.mockReset()
    ensureStandaloneDemoSeedMock.mockReset()
    ensureStandaloneDemoSeedMock.mockResolvedValue(true)
    vi.mocked(isLocalFirstEnabled).mockReset()
    vi.mocked(isLocalPinEnabled).mockReset()
    vi.mocked(isStandaloneLocalEnabled).mockReset()
    vi.mocked(isTauriRuntime).mockReset()
  })

  it('runs the gated standalone demo seed on boot when standalone mode is on', async () => {
    vi.mocked(isLocalFirstEnabled).mockReturnValue(true)
    vi.mocked(isLocalPinEnabled).mockReturnValue(false)
    vi.mocked(isStandaloneLocalEnabled).mockReturnValue(true)
    vi.mocked(isTauriRuntime).mockReturnValue(false)
    const db = fakeDb()
    wasmCreate.mockResolvedValue(db)

    await bootstrapLocalDb()

    expect(ensureStandaloneDemoSeedMock).toHaveBeenCalledTimes(1)
    expect(ensureStandaloneDemoSeedMock).toHaveBeenCalledWith(db)
    await expect(getLocalDb()).resolves.toBe(db)
  })
})
