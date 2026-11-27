import type { DemoSeedState, StandaloneDemoStatus } from '@domain/standaloneDemo'

export interface StandaloneDemoDataSnapshot {
  status: StandaloneDemoStatus
  seedState: DemoSeedState | null
  accountCount: number
  transactionCount: number
}

export interface StandaloneDemoDataPort {
  readSnapshot(): Promise<StandaloneDemoDataSnapshot>
  clearDemoData(): Promise<StandaloneDemoDataSnapshot>
  resetToDemoData(): Promise<StandaloneDemoDataSnapshot>
}
