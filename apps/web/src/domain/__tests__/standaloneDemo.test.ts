import { describe, expect, it } from 'vitest'
import {
  deriveStandaloneDemoStatus,
  parseDemoSeedState,
  resolveDemoSeedStateForExistingStore,
  shouldSeedStandaloneDemo,
} from '../standaloneDemo'

describe('standaloneDemo domain rules', () => {
  it('seeds only a never-seeded empty store', () => {
    expect(shouldSeedStandaloneDemo(null, 0)).toBe(true)
    expect(shouldSeedStandaloneDemo(null, 1)).toBe(false)
    expect(shouldSeedStandaloneDemo('seeded', 0)).toBe(false)
    expect(shouldSeedStandaloneDemo('dismissed', 0)).toBe(false)
  })

  it('classifies demo, custom and empty workspaces from the marker and live accounts', () => {
    expect(deriveStandaloneDemoStatus('seeded', 6)).toBe('demo')
    expect(deriveStandaloneDemoStatus('dismissed', 0)).toBe('empty')
    expect(deriveStandaloneDemoStatus('dismissed', 2)).toBe('custom')
    expect(deriveStandaloneDemoStatus(null, 6)).toBe('custom')
  })

  it('treats unknown marker values as unset and adopts demo workspace rows on upgrade', () => {
    expect(parseDemoSeedState('seeded')).toBe('seeded')
    expect(parseDemoSeedState('nonsense')).toBeNull()
    expect(resolveDemoSeedStateForExistingStore(true)).toBe('seeded')
    expect(resolveDemoSeedStateForExistingStore(false)).toBe('dismissed')
  })
})
