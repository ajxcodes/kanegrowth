import type { StandaloneDemoDataPort } from '@ports/demoData/StandaloneDemoDataPort'
import { getLocalDb } from '@platform/db/localDbInstance'
import { SqliteStandaloneDemoDataAdapter } from './SqliteStandaloneDemoDataAdapter'

export const createStandaloneDemoDataService = async (): Promise<StandaloneDemoDataPort> => {
  const db = await getLocalDb()
  return new SqliteStandaloneDemoDataAdapter(db)
}
