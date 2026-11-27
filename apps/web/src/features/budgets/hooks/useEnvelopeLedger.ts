import { useCallback, useEffect, useRef } from 'react'
import type { EnvelopeMonthView, EnvelopeWarning } from '@domain/envelope'
import type {
  AssignInput,
  EnvelopeLedgerPort,
  EnvelopeMonthQuery,
  EnvelopeMutationResult,
  MigrateCapResult,
  MoveAllocationInput,
  RecordIncomeInput,
} from '@ports/envelope/EnvelopeLedgerPort'
import { createEnvelopeLedgerService } from '@adapters/envelope/createEnvelopeLedgerService'
import { useLocalQuery } from '@platform/db/useLocalQuery'
import { useUser } from '@/app/providers/useUser'
import { useWorkspace } from '@/app/providers/useWorkspace'
import { DEFAULT_TIMEZONE } from '@shared/timezone'

export interface UseEnvelopeLedgerOptions {
  month: string
  workspaceId?: string | null
  timezone?: string
  accountIds?: string[]
}

export interface UseEnvelopeLedgerResult {
  view: EnvelopeMonthView | null
  assign: (input: Omit<AssignInput, 'workspaceId' | 'userId' | 'timezone'> & { workspaceId?: string | null }) => Promise<EnvelopeMutationResult>
  moveAllocation: (input: Omit<MoveAllocationInput, 'workspaceId' | 'userId' | 'timezone'> & { workspaceId?: string | null }) => Promise<EnvelopeMutationResult>
  closeMonth: (input?: { month?: string }) => Promise<EnvelopeMutationResult>
  reopenMonth: (input?: { month?: string }) => Promise<EnvelopeMutationResult>
  migrateCapToEnvelopeTarget: (budgetId: string) => Promise<MigrateCapResult>
  recordIncome: (input: Omit<RecordIncomeInput, 'workspaceId' | 'userId' | 'timezone'> & { workspaceId?: string | null }) => Promise<EnvelopeMutationResult & { transactionId: string }>
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
}

const TABLES = ['envelopeAssignments', 'transactions', 'categories', 'budgets'] as const

/**
 * Wraps `createEnvelopeLedgerService()`; `useLocalQuery(['envelopeAssignments','transactions','categories','budgets'], …getMonthView…)`.
 * No SQL in React. `tableInvalidationBus` invalidation drives refetch.
 */
export const useEnvelopeLedger = (options: UseEnvelopeLedgerOptions): UseEnvelopeLedgerResult => {
  const { month, accountIds } = options
  const { user } = useUser()
  const { activeWorkspaceId } = useWorkspace()
  const workspaceId = options.workspaceId !== undefined ? options.workspaceId : activeWorkspaceId ?? null
  const timezone = options.timezone ?? user?.timezone?.trim() ?? DEFAULT_TIMEZONE
  const userId = user?._id ?? ''

  const serviceRef = useRef<Promise<EnvelopeLedgerPort> | null>(null)
  const getService = useCallback((): Promise<EnvelopeLedgerPort> => {
    if (!serviceRef.current) serviceRef.current = createEnvelopeLedgerService()
    return serviceRef.current
  }, [])

  const query: EnvelopeMonthQuery = { month, workspaceId, timezone, accountIds: accountIds ?? [] }

  const fetcher = useCallback(async (): Promise<EnvelopeMonthView> => {
    const service = await getService()
    return service.getMonthView(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getService, month, workspaceId, timezone, (accountIds ?? []).join(',')])

  const localQuery = useLocalQuery<EnvelopeMonthView>([...TABLES], fetcher)

  // refetch when month/workspace/timezone changes
  useEffect(() => {
    void localQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, workspaceId, timezone, (accountIds ?? []).join(',')])

  const assign = useCallback<UseEnvelopeLedgerResult['assign']>(
    async (input) => (await getService()).assign({ ...input, workspaceId: input.workspaceId ?? workspaceId, userId, timezone }),
    [getService, workspaceId, userId, timezone]
  )

  const moveAllocation = useCallback<UseEnvelopeLedgerResult['moveAllocation']>(
    async (input) => (await getService()).moveAllocation({ ...input, workspaceId: input.workspaceId ?? workspaceId, userId, timezone }),
    [getService, workspaceId, userId, timezone]
  )

  const closeMonth = useCallback<UseEnvelopeLedgerResult['closeMonth']>(
    async (input) => (await getService()).closeMonth({ month: input?.month ?? month, workspaceId, userId, timezone }),
    [getService, month, workspaceId, userId, timezone]
  )

  const reopenMonth = useCallback<UseEnvelopeLedgerResult['reopenMonth']>(
    async (input) => (await getService()).reopenMonth({ month: input?.month ?? month, workspaceId, userId, timezone }),
    [getService, month, workspaceId, userId, timezone]
  )

  const migrateCapToEnvelopeTarget = useCallback<UseEnvelopeLedgerResult['migrateCapToEnvelopeTarget']>(
    async (budgetId) => (await getService()).migrateCapToEnvelopeTarget({ budgetId, workspaceId, userId }),
    [getService, workspaceId, userId]
  )

  const recordIncome = useCallback<UseEnvelopeLedgerResult['recordIncome']>(
    async (input) => (await getService()).recordIncome({ ...input, workspaceId: input.workspaceId ?? workspaceId, userId, timezone }),
    [getService, workspaceId, userId, timezone]
  )

  return {
    view: localQuery.data,
    assign,
    moveAllocation,
    closeMonth,
    reopenMonth,
    migrateCapToEnvelopeTarget,
    recordIncome,
    loading: localQuery.loading,
    error: localQuery.error,
    refetch: localQuery.refetch,
  }
}

export type { EnvelopeWarning }
