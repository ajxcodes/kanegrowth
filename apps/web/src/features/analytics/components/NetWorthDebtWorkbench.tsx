import React, { useMemo, useState } from 'react'
import type {
  DebtPayoffOptions,
  NetWorthAndDebtReport,
  PayoffStrategy,
} from '@domain/analytics/types'
import { formatMinorCurrency } from '../hooks/useAnalyticsData'

interface NetWorthDebtWorkbenchProps {
  report: NetWorthAndDebtReport | null
  options: DebtPayoffOptions
  onOptionsChange: (updater: (prev: DebtPayoffOptions) => DebtPayoffOptions) => void
}

const NetWorthDebtWorkbench: React.FC<NetWorthDebtWorkbenchProps> = ({
  report,
  options,
  onOptionsChange,
}) => {
  const [activeStrategy, setActiveStrategy] = useState<PayoffStrategy>('avalanche')

  const latest = report?.timeline[report.timeline.length - 1] ?? null
  const activeSummary =
    activeStrategy === 'avalanche' ? report?.avalanche ?? null : report?.snowball ?? null

  const combinedPoints = useMemo(() => {
    if (!report) return []
    return [
      ...report.timeline.map((p) => ({ ...p, isProjected: false })),
      ...report.projectionTimeline.slice(0, 12).map((p) => ({ ...p, isProjected: true })),
    ]
  }, [report])

  const chartW = 720
  const chartH = 240
  const padL = 62
  const padR = 16
  const padT = 18
  const padB = 30
  const innerW = chartW - padL - padR
  const innerH = chartH - padT - padB

  const maxAbs = useMemo(() => {
    let max = 100_000
    for (const p of combinedPoints) {
      max = Math.max(max, Math.abs(p.assetsMinor), Math.abs(p.liabilitiesMinor), Math.abs(p.netWorthMinor))
    }
    return max
  }, [combinedPoints])

  const toPath = (getter: (p: (typeof combinedPoints)[number]) => number): string => {
    if (combinedPoints.length === 0) return ''
    const step = innerW / Math.max(1, combinedPoints.length - 1)
    return combinedPoints
      .map((p, idx) => {
        const x = padL + idx * step
        const y = padT + innerH - (Math.max(0, getter(p)) / maxAbs) * innerH
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }

  return (
    <div data-testid="net-worth-panel" className="space-y-4">
      {/* Top KPI summary */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-elevated p-4">
          <div className="text-[11px] uppercase text-text-muted">Total Assets</div>
          <div data-testid="networth-assets" className="font-mono text-lg font-bold text-positive">
            {formatMinorCurrency(latest?.assetsMinor ?? 0)}
          </div>
          {latest && (
            <div className="mt-1 text-[11px] text-text-muted">
              Banking {formatMinorCurrency(latest.byAccountGroup.banking)} · Cash{' '}
              {formatMinorCurrency(latest.byAccountGroup.cash)} · Invest{' '}
              {formatMinorCurrency(latest.byAccountGroup.investment)}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-elevated p-4">
          <div className="text-[11px] uppercase text-text-muted">Total Liabilities</div>
          <div data-testid="networth-liabilities" className="font-mono text-lg font-bold text-negative">
            {formatMinorCurrency(latest?.liabilitiesMinor ?? 0)}
          </div>
          {latest && (
            <div className="mt-1 text-[11px] text-text-muted">
              Credit {formatMinorCurrency(Math.abs(latest.byAccountGroup.credit))} · Loans{' '}
              {formatMinorCurrency(Math.abs(latest.byAccountGroup.loan))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-elevated p-4">
          <div className="text-[11px] uppercase text-text-muted">Current Net Worth</div>
          <div data-testid="networth-total" className="font-mono text-lg font-bold text-text-primary">
            {formatMinorCurrency(latest?.netWorthMinor ?? 0)}
          </div>
          <div className="mt-1 text-[11px] text-text-muted">
            Offline local SQLCipher/SQLite ledger
          </div>
        </div>
      </div>

      {/* Historical + Projected Net Worth Timeline SVG */}
      <div className="rounded-xl border border-border bg-elevated p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text-primary">
            Net Worth Timeline (Historical & 12-Month Projection)
          </h2>
          <div className="flex items-center gap-3 text-[11px] text-text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-positive" /> Assets
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-accent" /> Net Worth
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-negative" /> Liabilities
            </span>
          </div>
        </div>

        <div className="w-full overflow-hidden">
          <svg
            data-testid="networth-svg"
            viewBox={`0 0 ${chartW} ${chartH}`}
            role="img"
            aria-label="Historical and projected net worth chart"
            className="w-full h-auto max-h-[260px]"
          >
            {[0, 0.5, 1].map((frac) => {
              const y = padT + innerH - frac * innerH
              return (
                <g key={frac}>
                  <line
                    x1={padL}
                    x2={chartW - padR}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    className="text-border-subtle"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={padL - 8}
                    y={y + 4}
                    textAnchor="end"
                    fontSize={10}
                    className="fill-text-muted font-mono"
                  >
                    ${Math.round((maxAbs * frac) / 100_000)}k
                  </text>
                </g>
              )
            })}
            <path d={toPath((p) => p.assetsMinor)} fill="none" stroke="#4ade80" strokeWidth={2} />
            <path d={toPath((p) => p.netWorthMinor)} fill="none" stroke="#d4af37" strokeWidth={2.5} />
            <path d={toPath((p) => p.liabilitiesMinor)} fill="none" stroke="#fb7185" strokeWidth={2} />
          </svg>
        </div>
      </div>

      {/* Snowball vs Avalanche What-If Debt Payoff Simulator */}
      <div className="rounded-xl border border-border bg-elevated p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              Debt Payoff Projections (Snowball vs. Avalanche)
            </h2>
            <p className="text-xs text-text-muted">
              Model extra monthly payments and one-time lump sums to see interest saved and debt-free date.
            </p>
          </div>

          <div className="inline-flex rounded-lg border border-border bg-bg-secondary p-0.5">
            {(['avalanche', 'snowball'] as PayoffStrategy[]).map((strategy) => (
              <button
                key={strategy}
                type="button"
                data-testid={`debt-strategy-${strategy}`}
                onClick={() => setActiveStrategy(strategy)}
                className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  activeStrategy === strategy
                    ? 'bg-accent text-on-accent'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {strategy}
              </button>
            ))}
          </div>
        </div>

        {report?.warning && (
          <div className="rounded-lg border border-negative-border bg-negative-subtle px-3 py-2 text-xs text-negative">
            {report.warning}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="debt-extra-monthly" className="font-medium text-text-secondary">
                Extra Monthly Payment
              </label>
              <span data-testid="debt-extra-monthly-value" className="font-mono font-semibold text-text-primary">
                {formatMinorCurrency(options.extraMonthlyMinor)}
              </span>
            </div>
            <input
              id="debt-extra-monthly"
              data-testid="debt-extra-monthly-slider"
              type="range"
              min={0}
              max={150_000}
              step={5_000}
              value={options.extraMonthlyMinor}
              onChange={(e) =>
                onOptionsChange((prev) => ({
                  ...prev,
                  extraMonthlyMinor: Number(e.target.value),
                }))
              }
              className="w-full accent-accent"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="debt-lump-sum" className="font-medium text-text-secondary">
                One-Time Lump Sum
              </label>
              <span data-testid="debt-lump-sum-value" className="font-mono font-semibold text-text-primary">
                {formatMinorCurrency(options.lumpSumMinor)}
              </span>
            </div>
            <input
              id="debt-lump-sum"
              data-testid="debt-lump-sum-slider"
              type="range"
              min={0}
              max={500_000}
              step={25_000}
              value={options.lumpSumMinor}
              onChange={(e) =>
                onOptionsChange((prev) => ({
                  ...prev,
                  lumpSumMinor: Number(e.target.value),
                }))
              }
              className="w-full accent-accent"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-lg border border-border-subtle bg-bg-secondary p-3">
            <div className="text-[11px] uppercase text-text-muted">Debt-Free Date ({activeStrategy})</div>
            <div data-testid="debt-free-date" className="font-mono text-base font-bold text-text-primary">
              {activeSummary?.debtFreeDate ?? '—'}
            </div>
            <div data-testid="debt-free-months" className="text-[11px] text-text-muted">
              {activeSummary?.debtFreeMonths ?? 0} months
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-bg-secondary p-3">
            <div className="text-[11px] uppercase text-text-muted">Total Interest Paid</div>
            <div data-testid="debt-total-interest" className="font-mono text-base font-bold text-negative">
              {formatMinorCurrency(activeSummary?.totalInterestPaidMinor ?? 0)}
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-bg-secondary p-3">
            <div className="text-[11px] uppercase text-text-muted">Interest Saved vs. Minimum</div>
            <div data-testid="debt-interest-saved" className="font-mono text-base font-bold text-positive">
              {formatMinorCurrency(activeSummary?.interestSavedVsMinimumMinor ?? 0)}
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-bg-secondary p-3">
            <div className="text-[11px] uppercase text-text-muted">Avalanche Advantage</div>
            <div data-testid="debt-avalanche-advantage" className="font-mono text-base font-bold text-accent">
              {formatMinorCurrency(report?.interestSavedByAvalancheMinor ?? 0)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default NetWorthDebtWorkbench
