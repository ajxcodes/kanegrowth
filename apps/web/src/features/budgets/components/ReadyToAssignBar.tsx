import React from 'react'
import { formatCurrency } from '@lib/format'
import { DEFAULT_CURRENCY } from '@lib/currencies'

export interface ReadyToAssignBarProps {
  /** `readyToAssign` integer minor. */
  readyToAssignMinor: number
  /** `incomeThisMonth` integer minor. */
  incomeThisMonthMinor?: number
  /** `assignedThisMonth` integer minor. */
  assignedThisMonthMinor?: number
  currency?: string
  /** `readyToAssign < 0` warning. */
  warnings?: string[]
}

const toMajor = (minor: number): number => minor / 100

/**
 * **Ready to Assign** balance (AC2/AC3): `data-testid="ready-to-assign"`; `incomeThisMonth`,
 * `assignedThisMonth`; **warning** when `readyToAssign < 0` (`data-testid="over-assignment-warning"`);
 * "every unit assigned" when `readyToAssign === 0`. No SQL.
 */
const ReadyToAssignBar: React.FC<ReadyToAssignBarProps> = ({
  readyToAssignMinor,
  incomeThisMonthMinor = 0,
  assignedThisMonthMinor = 0,
  currency = DEFAULT_CURRENCY,
  warnings = [],
}) => {
  const overAssigned = readyToAssignMinor < 0 || warnings.includes('over-assignment') || warnings.includes('negative-ready-to-assign')
  const everyUnitAssigned = readyToAssignMinor === 0

  return (
    <div className="card space-y-2" data-testid="ready-to-assign-bar">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs text-fg-muted uppercase tracking-wide">Ready to Assign</p>
          <p className="text-2xl font-semibold" data-testid="ready-to-assign">
            {formatCurrency(toMajor(readyToAssignMinor), currency)}
          </p>
        </div>
        <div className="text-xs text-fg-muted space-y-0.5 text-right">
          <p>Income this month: {formatCurrency(toMajor(incomeThisMonthMinor), currency)}</p>
          <p>Assigned this month: {formatCurrency(toMajor(assignedThisMonthMinor), currency)}</p>
        </div>
      </div>

      {everyUnitAssigned && !overAssigned && (
        <p className="text-sm text-income" data-testid="every-unit-assigned">Every unit assigned</p>
      )}

      {overAssigned && (
        <p className="text-sm text-expense" role="alert" data-testid="over-assignment-warning">
          Over-assignment: ready to assign is negative. Reduce assignments or add income.
        </p>
      )}
    </div>
  )
}

export default ReadyToAssignBar
