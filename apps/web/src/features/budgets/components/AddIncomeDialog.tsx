import React, { useMemo, useState } from 'react'
import Modal from '@ui/Modal'
import FormField from '@ui/forms/FormField'
import { toMinorUnits, parseAmountToMinorUnits } from '@shared/money'
import { DEFAULT_CURRENCY } from '@lib/currencies'
import { toDateInputValue } from '@lib/format'
import { EnvelopeError } from '@domain/envelope'
import { createEnvelopeLedgerService } from '@adapters/envelope/createEnvelopeLedgerService'
import { useLocalQuery } from '@platform/db/useLocalQuery'
import { Repository } from '@platform/db/repositories/Repository'
import type { LocalAccount } from '@domain/types'
import type { LocalDb } from '@platform/db/LocalDb'
import type { EnvelopeMutationResult, RecordIncomeInput } from '@ports/envelope/EnvelopeLedgerPort'
import type { Account } from '@features/accounts/types'

export interface EnvelopeChoice {
  envelopeId: string
  name: string
  envelopeType?: string
}

export interface AddIncomeDialogProps {
  open: boolean
  onClose: () => void
  /** Non-archived, workspace-scoped accounts. */
  accounts?: Account[]
  /** Envelope / sinking-fund categories for the optional one-step split. */
  envelopes?: EnvelopeChoice[]
  preferredCurrency?: string
  userId?: string
  workspaceId?: string | null
  timezone?: string
  /** Injected `EnvelopeLedgerPort.recordIncome`; defaults to `createEnvelopeLedgerService()`. */
  recordIncome?: (input: RecordIncomeInput) => Promise<EnvelopeMutationResult & { transactionId: string }>
  /** Fired after a successful income record. */
  onSubmitted?: (result: EnvelopeMutationResult & { transactionId: string }) => void
}

interface SplitRow {
  envelopeId: string
  amount: string
}

const todayInput = (): string => toDateInputValue(new Date())

/**
 * Explicit **Add Income / Paycheck** workflow (AC1). amount (major → `toMinorUnits`/`parseAmountToMinorUnits`
 * `@shared/money`), account, pay date `YYYY-MM-DD`, optional employer/source, optional notes, optional
 * one-step split across envelope/sinking-fund categories (`Σ splits ≤ amount`); remainder shown as
 * **Ready to Assign**. Currency defaults to workspace/user preferred (no revaluation). On submit calls
 * `EnvelopeLedgerPort.recordIncome(...)`. No SQL. No navigation away.
 */
const AddIncomeDialog: React.FC<AddIncomeDialogProps> = ({
  open,
  onClose,
  accounts = [],
  envelopes = [],
  preferredCurrency = DEFAULT_CURRENCY,
  userId = '',
  workspaceId = null,
  timezone,
  recordIncome,
  onSubmitted,
}) => {
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState('')
  const [payDate, setPayDate] = useState(todayInput())
  const [employer, setEmployer] = useState('')
  const [notes, setNotes] = useState('')
  const [splits, setSplits] = useState<SplitRow[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fallback: read non-archived accounts from local storage when no list is injected (no SQL in React).
  const localAccountsQuery = useLocalQuery<Account[]>(
    'accounts',
    (async (db: LocalDb) => {
      const repo = new Repository<LocalAccount>('accounts')
      const rows = await repo.list(db)
      return rows
        .filter((a) => !a.isArchived)
        .map((a): Account => ({
          _id: a._id, userId: a.userId ?? '', workspaceId: a.workspaceId ?? null, name: a.name, type: a.type as Account['type'],
          currency: a.currency, openingBalance: a.openingBalance ?? a.currentBalance, currentBalance: a.currentBalance,
          isDefault: false, isArchived: a.isArchived,
        }))
    }) as (db: LocalDb) => Promise<Account[]>
  )
  const availableAccounts = useMemo(
    () => (accounts.length > 0 ? accounts : (localAccountsQuery.data ?? [])).filter((a) => !a.isArchived),
    [accounts, localAccountsQuery.data]
  )
  const effectiveAccountId = accountId || availableAccounts[0]?._id || ''

  const amountMinor = useMemo(() => {
    if (amount.trim() === '') return 0
    try {
      return toMinorUnits(Number(amount))
    } catch {
      return 0
    }
  }, [amount])

  const splitsMinor = useMemo(
    () =>
      splits.reduce((sum, row) => {
        if (row.amount.trim() === '') return sum
        try {
          return sum + parseAmountToMinorUnits(row.amount)
        } catch {
          return sum
        }
      }, 0),
    [splits]
  )

  const remainingReadyToAssign = Math.max(0, amountMinor - splitsMinor)

  const addSplit = () => setSplits((s) => [...s, { envelopeId: envelopes[0]?.envelopeId ?? '', amount: '' }])
  const updateSplit = (index: number, patch: Partial<SplitRow>) =>
    setSplits((s) => s.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const removeSplit = (index: number) => setSplits((s) => s.filter((_, i) => i !== index))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    try {
      // Validate before any write (EnvelopeError on invalid input). TR-31.
      const parsedAmount = amount.trim() === '' ? NaN : parseAmountToMinorUnits(amount)
      if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
        throw new EnvelopeError('INVALID_AMOUNT', 'Amount must be a positive number')
      }
      if (!effectiveAccountId || !availableAccounts.some((a) => a._id === effectiveAccountId)) {
        throw new EnvelopeError('UNKNOWN_ACCOUNT', 'Select a valid account')
      }
      const parsedSplits = splits
        .filter((row) => row.amount.trim() !== '')
        .map((row) => {
          if (!row.envelopeId || !envelopes.some((env) => env.envelopeId === row.envelopeId)) {
            throw new EnvelopeError('INVALID_ENVELOPE', 'Select a valid envelope for each split')
          }
          return { envelopeId: row.envelopeId, amountMinor: parseAmountToMinorUnits(row.amount) }
        })
      const splitTotal = parsedSplits.reduce((s, x) => s + x.amountMinor, 0)
      if (splitTotal > parsedAmount) {
        throw new EnvelopeError('SPLIT_SUM_EXCEEDS_INCOME', 'Split amounts cannot exceed income')
      }

      const input: RecordIncomeInput = {
        userId,
        workspaceId,
        amountMinor: parsedAmount,
        accountId: effectiveAccountId,
        payDate,
        employer: employer.trim() || undefined,
        notes: notes.trim() || undefined,
        currency: preferredCurrency,
        timezone,
        splits: parsedSplits.length > 0 ? parsedSplits : undefined,
      }

      setSubmitting(true)
      const fn = recordIncome ?? ((async (i: RecordIncomeInput) => (await createEnvelopeLedgerService()).recordIncome(i)) as (i: RecordIncomeInput) => Promise<EnvelopeMutationResult & { transactionId: string }>)
      const result = await fn(input)
      onSubmitted?.(result)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record income')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Income / Paycheck" size="lg">
      <form data-testid="add-income-dialog" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField
            label="Amount"
            type="number"
            value={amount}
            onChange={setAmount}
            placeholder="1000.00"
            required
            min="0.01"
            step="0.01"
            disabled={submitting}
            testId="add-income-amount"
          />

          <label className="text-[13px] text-fg-secondary">
            Account
            <div className="input-box mb-0 mt-1">
              <select
                data-testid="add-income-account"
                value={effectiveAccountId}
                onChange={(e) => setAccountId(e.target.value)}
                required
                disabled={submitting}
                className="w-full bg-transparent outline-none text-fg"
              >
                {availableAccounts.map((a) => (
                  <option key={a._id} value={a._id} className="bg-surface">{a.name}</option>
                ))}
              </select>
            </div>
          </label>

          <FormField label="Pay date" type="date" value={payDate} onChange={setPayDate} required disabled={submitting} testId="add-income-date" />
        </div>

        <FormField label="Employer / source (optional)" value={employer} onChange={setEmployer} placeholder="Acme Co." disabled={submitting} testId="add-income-employer" />

        <FormField label="Notes (optional)" value={notes} onChange={setNotes} placeholder="January paycheck" disabled={submitting} testId="add-income-notes" />

        {/* Optional one-step split across envelopes / sinking funds */}
        <div data-testid="add-income-split" className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-fg-secondary">Split across envelopes (optional)</p>
            <button type="button" onClick={addSplit} disabled={submitting || envelopes.length === 0} className="text-xs text-accent hover:underline disabled:opacity-50">
              Add split
            </button>
          </div>
          {splits.map((row, index) => (
            <div key={index} className="grid grid-cols-1 sm:grid-cols-[1fr_120px_auto] gap-2 items-end">
              <label className="text-[13px] text-fg-secondary">
                Envelope
                <div className="input-box mb-0 mt-1">
                  <select
                    value={row.envelopeId}
                    onChange={(e) => updateSplit(index, { envelopeId: e.target.value })}
                    disabled={submitting}
                    className="w-full bg-transparent outline-none text-fg"
                  >
                    {envelopes.map((env) => (
                      <option key={env.envelopeId} value={env.envelopeId} className="bg-surface">{env.name}</option>
                    ))}
                  </select>
                </div>
              </label>
              <FormField label="Amount" type="number" value={row.amount} onChange={(v) => updateSplit(index, { amount: v })} placeholder="0.00" min="0" step="0.01" disabled={submitting} />
              <button type="button" onClick={() => removeSplit(index)} disabled={submitting} className="text-xs text-expense hover:underline pb-2 disabled:opacity-50">Remove</button>
            </div>
          ))}
        </div>

        {/* Unassigned balance always visible */}
        <div className="text-sm text-fg-secondary">
          Ready to Assign: <span data-testid="ready-to-assign" className="font-medium text-fg">{(remainingReadyToAssign / 100).toFixed(2)}</span>
        </div>

        {error && <p role="alert" className="text-sm text-expense">{error}</p>}

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} disabled={submitting} className="flex-1 px-4 py-2 text-sm font-medium rounded-lg border border-border text-fg-secondary hover:border-border transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" data-testid="add-income-submit" disabled={submitting} className="flex-1 px-4 py-2 text-sm font-medium rounded-lg btn-accent transition-colors disabled:opacity-50">
            {submitting ? 'Adding…' : 'Add Income'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default AddIncomeDialog
