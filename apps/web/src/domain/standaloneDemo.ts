/**
 * Pure decision rules for the standalone local-first demo dataset.
 *
 * The boot path and the Settings clear/reset actions share this single module so the
 * "should this store be seeded?" question has one answer. `_sync_meta.standaloneDemoSeed`
 * is the persistent marker: `seeded` means the canonical demo household is loaded,
 * `dismissed` means the user cleared it and a reload must not re-seed.
 */

export const STANDALONE_DEMO_SEED_META_KEY = 'standaloneDemoSeed'

export type DemoSeedState = 'seeded' | 'dismissed'

export type StandaloneDemoStatus = 'demo' | 'custom' | 'empty'

/**
 * `'seeded' | 'dismissed'` => the same value; anything else (including null/undefined,
 * a future marker value, or a corrupt row) => null, which is treated as "unset".
 */
export const parseDemoSeedState = (raw: string | null | undefined): DemoSeedState | null => {
  if (raw === 'seeded' || raw === 'dismissed') {
    return raw
  }
  return null
}

/** First-boot seeding only happens for a never-seeded, genuinely empty store. */
export const shouldSeedStandaloneDemo = (
  state: DemoSeedState | null,
  liveAccountCount: number
): boolean => state === null && liveAccountCount === 0

/**
 * Pre-marker upgrade path: an existing store with rows but no marker is adopted rather than
 * re-seeded. Demo fixtures are identifiable by their workspace id; anything else is user data.
 */
export const resolveDemoSeedStateForExistingStore = (
  hasDemoWorkspaceAccounts: boolean
): DemoSeedState => (hasDemoWorkspaceAccounts ? 'seeded' : 'dismissed')

export const deriveStandaloneDemoStatus = (
  state: DemoSeedState | null,
  liveAccountCount: number
): StandaloneDemoStatus => {
  if (liveAccountCount <= 0) {
    return 'empty'
  }
  if (state === 'seeded') {
    return 'demo'
  }
  return 'custom'
}
