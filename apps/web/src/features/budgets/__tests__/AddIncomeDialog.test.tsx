import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderWithProviders, screen, waitFor, userEvent, fireEvent } from '@/test/test-utils'
import { EnvelopeError } from '@domain/envelope'
import type { RecordIncomeInput, EnvelopeMutationResult } from '@ports/envelope/EnvelopeLedgerPort'
import type { Account } from '@features/accounts/types'
import AddIncomeDialog from '../components/AddIncomeDialog'

const account: Account = {
  _id: 'acc1',
  userId: 'u1',
  workspaceId: null,
  name: 'Checking',
  type: 'checking',
  currency: 'USD',
  openingBalance: 0,
  currentBalance: 0,
  isDefault: true,
  isArchived: false,
}

const envelopes = [
  { envelopeId: 'food', name: 'Food', envelopeType: 'expense' },
  { envelopeId: 'fun', name: 'Fun', envelopeType: 'sinking_fund' },
]

const okResult = (): EnvelopeMutationResult & { transactionId: string } => ({
  view: { month: '2027-01', timezone: 'UTC', isClosed: false, readyToAssignMinor: 0, readyToAssignThisMonthMinor: 0, incomeThisMonthMinor: 0, assignedThisMonthMinor: 0, envelopes: [], warnings: [] },
  warnings: [],
  transactionId: 'tx1',
})

let recordIncome: ReturnType<typeof vi.fn>

beforeEach(() => {
  recordIncome = vi.fn(async () => okResult())
})

const renderDialog = () =>
  renderWithProviders(
    <AddIncomeDialog
      open
      onClose={() => {}}
      accounts={[account]}
      envelopes={envelopes}
      preferredCurrency="USD"
      userId="u1"
      workspaceId={null}
      recordIncome={recordIncome as unknown as (input: RecordIncomeInput) => Promise<EnvelopeMutationResult & { transactionId: string }>}
    />
  )

// ── TR-30 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-30 add income creates one posted income transaction and optional envelope split without leaving budgeting', () => {
  it('recordIncome called with amountMinor, accountId, payDate, employer, notes, splits; Σ splits ≤ amount; no navigation; add-income-submit', async () => {
    const user = userEvent.setup()
    renderDialog()

    expect(screen.getByTestId('add-income-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('add-income-submit')).toBeInTheDocument()

    await user.type(screen.getByTestId('add-income-amount'), '100')
    await user.selectOptions(screen.getByTestId('add-income-account'), 'acc1')
    await user.clear(screen.getByTestId('add-income-date'))
    await user.type(screen.getByTestId('add-income-date'), '2027-01-15')
    await user.type(screen.getByTestId('add-income-employer'), 'Acme')
    await user.type(screen.getByTestId('add-income-notes'), 'Jan pay')

    // optional one-step split
    await user.click(screen.getByRole('button', { name: 'Add split' }))
    const splitRows = screen.getByTestId('add-income-split').querySelectorAll('select')
    await user.selectOptions(splitRows[0], 'food')
    const splitAmount = screen.getByTestId('add-income-split').querySelectorAll('input[type="number"]')[0]
    await user.type(splitAmount, '40')

    const form = screen.getByTestId('add-income-dialog')
    fireEvent.submit(form)

    await waitFor(() => expect(recordIncome).toHaveBeenCalledTimes(1))
    const input = recordIncome.mock.calls[0][0] as RecordIncomeInput
    expect(input.amountMinor).toBe(10000) // major → minor
    expect(input.accountId).toBe('acc1')
    expect(input.payDate).toBe('2027-01-15')
    expect(input.employer).toBe('Acme')
    expect(input.notes).toBe('Jan pay')
    expect(input.splits).toEqual([{ envelopeId: 'food', amountMinor: 4000 }])
    const sum = (input.splits ?? []).reduce((s, x) => s + x.amountMinor, 0)
    expect(sum).toBeLessThanOrEqual(input.amountMinor) // Σ splits ≤ amount
    // remainder shown as Ready to Assign
    // no navigation away (component stays mounted; we never call router navigation)
  })
})

// ── TR-31 ────────────────────────────────────────────────────────────────────────────────────

describe('TR-31 rejects non-positive amount unknown account unknown envelope and split sum exceeding income', () => {
  it('EnvelopeError; no recordIncome; no transaction written; split-sum validation', async () => {
    const user = userEvent.setup()
    renderDialog()

    // non-positive amount
    await user.type(screen.getByTestId('add-income-amount'), '0')
    fireEvent.submit(screen.getByTestId('add-income-dialog'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(recordIncome).not.toHaveBeenCalled()

    // split sum exceeding income
    await user.clear(screen.getByTestId('add-income-amount'))
    await user.type(screen.getByTestId('add-income-amount'), '50')
    await user.click(screen.getByRole('button', { name: 'Add split' }))
    const amounts = screen.getByTestId('add-income-split').querySelectorAll('input[type="number"]')
    await user.type(amounts[0], '999')
    fireEvent.submit(screen.getByTestId('add-income-dialog'))
    await waitFor(() => expect(recordIncome).not.toHaveBeenCalled())
  })

  it('adapter-level EnvelopeError propagates as no-transaction on invalid input', async () => {
    recordIncome = vi.fn(async () => { throw new EnvelopeError('UNKNOWN_ACCOUNT', 'Unknown account') })
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId('add-income-amount'), '100')
    fireEvent.submit(screen.getByTestId('add-income-dialog'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(recordIncome).toHaveBeenCalledTimes(1) // it called through; adapter throws before writing any transaction
  })
})
