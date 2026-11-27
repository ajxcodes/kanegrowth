import React, { useState } from 'react'
import { formatCurrency } from '@lib/format'
import { DEFAULT_CURRENCY } from '@lib/currencies'
import type { EnvelopeMonthView, EnvelopeRow } from '@domain/envelope'

export interface EnvelopeTableProps {
  /** Rendered `EnvelopeMonthView`. */
  view: EnvelopeMonthView | null
  currency?: string
  /** `EnvelopeLedgerPort.assign`. */
  onAssign?: (envelopeId: string, amountMinor: number) => void | Promise<void>
  /** `EnvelopeLedgerPort.moveAllocation`. */
  onMoveAllocation?: (fromEnvelopeId: string, toEnvelopeId: string, amountMinor: number) => void | Promise<void>
  /** Month selector. */
  month?: string
  onMonthChange?: (month: string) => void
  /** Month close / reopen. */
  onCloseMonth?: () => void | Promise<void>
  onReopenMonth?: () => void | Promise<void>
  /** Sinking-fund badge. */
  showSinkingFundBadge?: boolean
}

const toMajor = (minor: number): number => minor / 100
const minorFromInput = (value: string): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/**
 * **Envelope table** per month (AC2/AC4): columns **Envelope | Target | Budgeted | Activity | Available**;
 * rollover indicator `rolledOverNegative`; per-envelope inline **assigned** editor → `assign`;
 * **re-allocation** ("move") → `moveAllocation`; sinking-fund badge. **No SQL in component.**
 * test ids: `envelope-table`, `envelope-row`, `envelope-available`, `assign-input`, `move-allocation`.
 */
const EnvelopeTable: React.FC<EnvelopeTableProps> = ({
  view,
  currency = DEFAULT_CURRENCY,
  onAssign,
  onMoveAllocation,
  month,
  onMonthChange,
  onCloseMonth,
  onReopenMonth,
}) => {
  const [assignDrafts, setAssignDrafts] = useState<Record<string, string>>({})
  const [moveFrom, setMoveFrom] = useState('')
  const [moveTo, setMoveTo] = useState('')
  const [moveAmount, setMoveAmount] = useState('')

  const fmt = (minor: number): string => formatCurrency(toMajor(minor), currency)
  const envelopes = view?.envelopes ?? []
  const isClosed = view?.isClosed ?? false
  const currentMonth = month ?? view?.month ?? ''

  return (
    <div className="space-y-3" data-testid="envelope-table">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-[13px] text-fg-secondary" htmlFor="month-selector">Month</label>
          <input
            id="month-selector"
            data-testid="month-selector"
            type="month"
            value={currentMonth}
            onChange={(e) => onMonthChange?.(e.target.value)}
            className="input-box mb-0 w-44"
          />
          {isClosed && <span className="text-xs rounded-full bg-surface-hover border border-border px-2 py-0.5" data-testid="month-closed">Closed</span>}
        </div>
        <div className="flex items-center gap-2">
          {isClosed ? (
            <button type="button" data-testid="reopen-month-button" onClick={() => void onReopenMonth?.()} className="px-3 py-1.5 text-sm rounded-lg border border-border text-fg-secondary hover:border-border">
              Reopen month
            </button>
          ) : (
            <button type="button" data-testid="close-month-button" onClick={() => void onCloseMonth?.()} className="px-3 py-1.5 text-sm rounded-lg border border-border text-fg-secondary hover:border-border">
              Close month
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-fg-muted border-b border-border-subtle">
              <th className="py-2 pr-3">Envelope</th>
              <th className="py-2 pr-3">Target</th>
              <th className="py-2 pr-3">Budgeted</th>
              <th className="py-2 pr-3">Activity</th>
              <th className="py-2 pr-3">Available</th>
            </tr>
          </thead>
          <tbody>
            {envelopes.map((row: EnvelopeRow) => (
              <tr key={row.envelopeId} data-testid="envelope-row" className="border-b border-border-subtle">
                <td className="py-2 pr-3">
                  <span className="font-medium text-fg" data-testid="envelope-name">{row.name}{'\u200b'}</span>
                  {(row.envelopeType === 'sinking_fund' || row.envelopeType === 'savings') && (
                    <span className="ml-2 text-[11px] rounded-full bg-accent-subtle border border-accent/30 px-2 py-0.5 text-accent" data-testid="sinking-fund-badge">
                      Sinking fund
                    </span>
                  )}
                  {row.rolledOverNegative && (
                    <span className="ml-2 text-[11px] rounded-full bg-expense/10 border border-negative/20 px-2 py-0.5 text-expense" data-testid="rollover-negative">
                      Overspent rollover
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3">{fmt(row.targetMinor)}</td>
                <td className="py-2 pr-3">
                  <input
                    data-testid="assign-input"
                    type="number"
                    step="0.01"
                    aria-label={`Assigned for ${row.name}`}
                    value={assignDrafts[row.envelopeId] ?? (row.budgetedMinor / 100).toString()}
                    onChange={(e) => setAssignDrafts((d) => ({ ...d, [row.envelopeId]: e.target.value }))}
                    onBlur={(e) => {
                      if (!onAssign) return
                      const next = minorFromInput(e.target.value)
                      if (next !== row.budgetedMinor) void onAssign(row.envelopeId, next)
                    }}
                    className="input-box mb-0 w-28"
                  />
                </td>
                <td className={`py-2 pr-3 ${row.activityMinor < 0 ? 'text-expense' : ''}`}>{fmt(row.activityMinor)}</td>
                <td className={`py-2 pr-3 font-medium ${row.availableMinor < 0 ? 'text-expense' : ''}`} data-testid="envelope-available">
                  {fmt(row.availableMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {envelopes.length === 0 && <p className="text-sm text-fg-muted py-4 text-center">No envelopes yet.</p>}
      </div>

      {/* Re-allocation ("move") → moveAllocation */}
      {onMoveAllocation && envelopes.length > 1 && (
        <div className="flex items-end gap-2 flex-wrap" data-testid="move-allocation">
          <label className="text-[13px] text-fg-secondary">Move
            <div className="input-box mb-0 mt-1 w-32">
              <input type="number" step="0.01" min="0" value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} className="w-full bg-transparent outline-none" aria-label="Move amount" />
            </div>
          </label>
          <label className="text-[13px] text-fg-secondary">from
            <div className="input-box mb-0 mt-1">
              <select value={moveFrom} onChange={(e) => setMoveFrom(e.target.value)} className="bg-transparent outline-none" aria-label="Move from envelope">
                <option value="">—</option>
                {envelopes.map((e) => <option key={e.envelopeId} value={e.envelopeId} className="bg-surface">{e.name}</option>)}
              </select>
            </div>
          </label>
          <label className="text-[13px] text-fg-secondary">to
            <div className="input-box mb-0 mt-1">
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="bg-transparent outline-none" aria-label="Move to envelope">
                <option value="">—</option>
                {envelopes.map((e) => <option key={e.envelopeId} value={e.envelopeId} className="bg-surface">{e.name}</option>)}
              </select>
            </div>
          </label>
          <button
            type="button"
            onClick={() => {
              if (!moveFrom || !moveTo || moveFrom === moveTo) return
              void onMoveAllocation(moveFrom, moveTo, minorFromInput(moveAmount))
            }}
            className="px-3 py-1.5 text-sm rounded-lg btn-accent"
          >
            Move
          </button>
        </div>
      )}
    </div>
  )
}

export default EnvelopeTable
