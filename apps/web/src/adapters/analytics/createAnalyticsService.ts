import { isTauriRuntime } from '@lib/isTauri'
import { getLocalDbStorageMode } from '@platform/db/bootstrapLocalDb'
import { getLocalDb } from '@platform/db/localDbInstance'
import type { AnalyticsUseCasePort } from '@ports/analytics/AnalyticsUseCasePort'
import { SqliteAnalyticsAdapter } from './SqliteAnalyticsAdapter'
import { TauriAnalyticsAdapter } from './TauriAnalyticsAdapter'

let cachedService: AnalyticsUseCasePort | null = null

export const createAnalyticsService = async (): Promise<AnalyticsUseCasePort> => {
  if (cachedService) return cachedService
  const db = await getLocalDb()
  if (isTauriRuntime()) {
    cachedService = new TauriAnalyticsAdapter(db)
  } else {
    cachedService = new SqliteAnalyticsAdapter(db, {
      persistViewsToLocalStorageFallback: getLocalDbStorageMode() === 'memory-fallback',
    })
  }
  return cachedService
}

export const resetAnalyticsServiceCache = (): void => {
  cachedService = null
}
