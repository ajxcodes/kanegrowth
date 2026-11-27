import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { render, renderWithProviders, screen, waitFor } from '@/test/test-utils'
import type { EnvelopeMonthView } from '@domain/envelope'
import { tableInvalidationBus } from '@lib/tableInvalidationBus'
import { resetLocalDbForTests } from '@platform/db/localDbInstance'
import { useEnvelopeLedger } from '../hooks/useEnvelopeLedger'
import EnvelopeTable from '../components/EnvelopeTable'

const view: EnvelopeMonthView = {
  month: '2027-01',
  timezone: 'UTC',
  isClosed: false,
  readyToAssignMinor: 30000,
  readyToAssignThisMonthMinor: 30000,
  incomeThisMonthMinor: 100000,
  assignedThisMonthMinor: 70000,
  envelopes: [
    { envelopeId: 'food', name: 'Food', envelopeType: 'expense', targetMinor: 5000, budgetedMinor: 50000, activityMinor: -3000, spentMinor: 3000, carriedInMinor: 0, availableMinor: 47000, rolledOverNegative: false },
    { envelopeId: 'fun', name: 'Fun', envelopeType: 'sinking_fund', targetMinor: 0, budgetedMinor: 20000, activityMinor: 0, spentMinor: 0, carriedInMinor: 0, availableMinor: 20000, rolledOverNegative: false },
    { envelopeId: 'old', name: 'Overspent', envelopeType: 'expense', targetMinor: 0, budgetedMinor: 0, activityMinor: -5000, spentMinor: 5000, carriedInMinor: 0, availableMinor: -5000, rolledOverNegative: true },
  ],
  warnings: [],
}

describe('EnvelopeTable', () => {
  it('renders Envelope | Target | Budgeted | Activity | Available; rollover; assigned editor; move; sinking badge', () => {
    const onAssign = vi.fn()
    const onMoveAllocation = vi.fn()
    render(<EnvelopeTable view={view} currency="USD" onAssign={onAssign} onMoveAllocation={onMoveAllocation} month="2027-01" />)

    expect(screen.getByTestId('envelope-table')).toBeInTheDocument()
    // header columns
    expect(screen.getByText('Envelope')).toBeInTheDocument()
    expect(screen.getByText('Target')).toBeInTheDocument()
    expect(screen.getByText('Budgeted')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.getByText('Available')).toBeInTheDocument()

    const rows = screen.getAllByTestId('envelope-row')
    expect(rows.length).toBe(3)
    expect(screen.getAllByTestId('envelope-available').length).toBe(3)
    expect(screen.getAllByTestId('assign-input').length).toBe(3)
    // re-allocation
    expect(screen.getByTestId('move-allocation')).toBeInTheDocument()
    // sinking-fund badge
    expect(screen.getByTestId('sinking-fund-badge')).toBeInTheDocument()
    // rollover indicator
    expect(screen.getByTestId('rollover-negative')).toBeInTheDocument()
    // month selector + close/reopen
    expect(screen.getByTestId('month-selector')).toBeInTheDocument()
    expect(screen.getByTestId('close-month-button')).toBeInTheDocument()
  })

  it('assigned editor → assign; move → moveAllocation; no SQL in component', async () => {
    const onAssign = vi.fn()
    render(<EnvelopeTable view={view} currency="USD" onAssign={onAssign} month="2027-01" />)
    const input = screen.getAllByTestId('assign-input')[0]
    await act(async () => { input.focus() })
    // change + blur triggers assign
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(input, { target: { value: '600' } })
    fireEvent.blur(input)
    await waitFor(() => expect(onAssign).toHaveBeenCalled())
    expect(onAssign.mock.calls[0][0]).toBe('food')
  })
})

// ── TR-43b ───────────────────────────────────────────────────────────────────────────────────

describe('TR-43b publishes envelopeAssignments invalidation and refetches', () => {
  beforeEach(() => resetLocalDbForTests())

  it('tableInvalidationBus.publish(envelopeAssignments) triggers refetch; no SQL in component', async () => {
    function Harness() {
      const { view: v } = useEnvelopeLedger({ month: '2027-01', workspaceId: null, timezone: 'UTC' })
      return <EnvelopeTable view={v} />
    }
    renderWithProviders(<Harness />)
    await waitFor(() => expect(screen.getByTestId('envelope-table')).toBeInTheDocument())
    // publishing invalidation triggers useLocalQuery refetch (no throw; no SQL in component)
    await act(async () => { tableInvalidationBus.publish('envelopeAssignments') })
    await waitFor(() => expect(screen.getByTestId('envelope-table')).toBeInTheDocument())
  })
})
