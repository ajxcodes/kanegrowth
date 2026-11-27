import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import toast from 'react-hot-toast'
import StandaloneDemoDataSettings from '../StandaloneDemoDataSettings'

const mocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  clearDemoData: vi.fn(),
  resetToDemoData: vi.fn(),
}))

vi.mock('@adapters/demoData/createStandaloneDemoDataService', () => ({
  createStandaloneDemoDataService: vi.fn(async () => ({
    readSnapshot: mocks.readSnapshot,
    clearDemoData: mocks.clearDemoData,
    resetToDemoData: mocks.resetToDemoData,
  })),
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

const demoSnapshot = {
  status: 'demo' as const,
  seedState: 'seeded' as const,
  accountCount: 6,
  transactionCount: 62,
}

const emptySnapshot = {
  status: 'empty' as const,
  seedState: 'dismissed' as const,
  accountCount: 0,
  transactionCount: 0,
}

describe('StandaloneDemoDataSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readSnapshot.mockResolvedValue(demoSnapshot)
    mocks.clearDemoData.mockResolvedValue(emptySnapshot)
    mocks.resetToDemoData.mockResolvedValue(demoSnapshot)
  })

  it('requires confirmation before clearing demo data', async () => {
    const user = userEvent.setup()
    render(<StandaloneDemoDataSettings />)

    expect(await screen.findByText('Demo data is loaded')).toBeInTheDocument()

    await user.click(screen.getByTestId('clear-demo-data-button'))
    expect(mocks.clearDemoData).not.toHaveBeenCalled()
    expect(screen.getByTestId('demo-data-confirm-clear')).toBeInTheDocument()

    await user.click(screen.getByTestId('demo-data-confirm-clear'))
    expect(mocks.clearDemoData).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.getByTestId('demo-data-status')).toHaveTextContent('Workspace is empty')
    )
    expect(toast.success).toHaveBeenCalledWith('Demo data cleared')
  })

  it('cancelling the clear confirmation leaves the demo data untouched', async () => {
    const user = userEvent.setup()
    render(<StandaloneDemoDataSettings />)

    expect(await screen.findByText('Demo data is loaded')).toBeInTheDocument()

    await user.click(screen.getByTestId('clear-demo-data-button'))
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(mocks.clearDemoData).not.toHaveBeenCalled()
    expect(screen.getByTestId('demo-data-status')).toHaveTextContent('Demo data is loaded')
  })

  it('requires confirmation before resetting to the demo dataset', async () => {
    const user = userEvent.setup()
    render(<StandaloneDemoDataSettings />)

    expect(await screen.findByText('Demo data is loaded')).toBeInTheDocument()

    await user.click(screen.getByTestId('reset-demo-data-button'))
    expect(mocks.resetToDemoData).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('demo-data-confirm-reset'))
    expect(mocks.resetToDemoData).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('demo-data-status')).toHaveTextContent('Demo data is loaded')
    expect(toast.success).toHaveBeenCalledWith('Demo data reset')
  })

  it('disables clear when the workspace is empty and surfaces a failed reset', async () => {
    mocks.readSnapshot.mockResolvedValue(emptySnapshot)
    mocks.resetToDemoData.mockRejectedValue(new Error('sqlite transaction rolled back'))
    const user = userEvent.setup()
    render(<StandaloneDemoDataSettings />)

    expect(await screen.findByText('Workspace is empty')).toBeInTheDocument()
    expect(screen.getByTestId('clear-demo-data-button')).toBeDisabled()

    await user.click(screen.getByTestId('reset-demo-data-button'))
    await user.click(screen.getByTestId('demo-data-confirm-reset'))

    expect(await screen.findByTestId('demo-data-error')).toHaveTextContent(
      'Failed to reset demo data. Your data was not changed.'
    )
    expect(toast.error).toHaveBeenCalled()
  })
})
