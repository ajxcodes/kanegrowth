import React from 'react'
import { FiX } from 'react-icons/fi'
import type { TransactionRecord } from '@domain/analytics/types'
import { formatMinorCurrency } from '../hooks/useAnalyticsData'

interface TransactionDrilldownDrawerProps {
  open: boolean
  title: string
  expectedMinor: number | null
  transactions: TransactionRecord[]
  loading: boolean
  onClose: () => void
}

const TransactionDrilldownDrawer: React.FC<TransactionDrilldownDrawerProps> = ({
  open,
  title,
  expectedMinor,
  transactions,
  loading,
  onClose,
}) => {
  if (!open) return null

  const computedSumMinor = transactions.reduce((sum, tx) => {
    if (tx.txType === 'expense') return sum + Math.abs(tx.amountMinor)
    if (tx.txType === 'income') {
      return transactions.some((t) => t.txType === 'expense')
        ? sum - Math.abs(tx.amountMinor)
        : sum + Math.abs(tx.amountMinor)
    }
    return sum + Math.abs(tx.amountMinor)
  }, 0)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Transactions for ${title}`}
      data-testid="drilldown-drawer"
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
    >
      <div className="flex h-full w-full max-w-md flex-col border-l border-border bg-bg-secondary shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-primary">{title}</h2>
            <p className="text-xs text-text-muted">
              {transactions.length} matching transaction{transactions.length === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            data-testid="drilldown-close-btn"
            aria-label="Close drill-down drawer"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-elevated-hover hover:text-text-primary"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="flex items-center justify-between border-b border-border-subtle bg-elevated px-4 py-2.5 text-xs">
          <span className="text-text-muted">Drill-down Total</span>
          <span data-testid="drilldown-total" className="font-mono font-bold text-text-primary">
            {formatMinorCurrency(expectedMinor ?? computedSumMinor)}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="py-8 text-center text-xs text-text-muted">Loading transactions...</div>
          ) : transactions.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted">
              No underlying transactions found.
            </div>
          ) : (
            transactions.map((tx) => (
              <div
                key={tx.id}
                data-testid={`drilldown-row-${tx.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-elevated px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-text-primary">
                    {tx.description || tx.categoryId}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    {tx.date} · {tx.isShared ? 'Shared' : 'Individual'}
                  </div>
                </div>
                <div
                  className={`font-mono text-xs font-semibold shrink-0 ${
                    tx.txType === 'income' ? 'text-positive' : 'text-text-primary'
                  }`}
                >
                  {tx.txType === 'income' ? '+' : ''}
                  {formatMinorCurrency(tx.amountMinor)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default TransactionDrilldownDrawer
