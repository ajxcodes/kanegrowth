import type { EnvelopeLedgerPort } from '@ports/envelope/EnvelopeLedgerPort'
import { getLocalDb } from '@platform/db/localDbInstance'
import { SqliteEnvelopeLedgerAdapter } from './SqliteEnvelopeLedgerAdapter'

/** Factory (mirrors `@adapters/demoData/createStandaloneDemoDataService`): `new SqliteEnvelopeLedgerAdapter(await getLocalDb())`. */
export const createEnvelopeLedgerService = async (): Promise<EnvelopeLedgerPort> => {
  const db = await getLocalDb()
  return new SqliteEnvelopeLedgerAdapter(db)
}
