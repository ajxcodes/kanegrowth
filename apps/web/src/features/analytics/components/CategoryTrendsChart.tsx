import React, { useMemo, useState } from 'react'
import type {
  CategoryTrendPoint,
  CategoryTrendsReport,
  DrilldownCriteria,
} from '@domain/analytics/types'
import { formatMinorCurrency } from '../hooks/useAnalyticsData'

interface CategoryTrendsChartProps {
  report: CategoryTrendsReport | null
  rollingWindow: number
  onRollingWindowChange: (window: number) => void
  onDrilldown: (title: string, expectedMinor: number | null, criteria: DrilldownCriteria) => void
}

const CategoryTrendsChart: React.FC<CategoryTrendsChartProps> = ({
  report,
  rollingWindow,
  onRollingWindowChange,
  onDrilldown,
}) => {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('')
  const [comparisonMode, setComparisonMode] = useState<'mom' | 'yoy'>('mom')

  const effectiveCategoryId = useMemo(() => {
    if (!report || report.summaries.length === 0) return ''
    if (selectedCategoryId && report.summaries.some((s) => s.categoryId === selectedCategoryId)) {
      return selectedCategoryId
    }
    const withAnomaly = report.summaries.find((s) => s.anomalyCount > 0)
    return withAnomaly?.categoryId ?? report.summaries[0].categoryId
  }, [report, selectedCategoryId])

  const points: CategoryTrendPoint[] = useMemo(() => {
    if (!report || !effectiveCategoryId) return []
    return report.series.filter((p) => p.categoryId === effectiveCategoryId)
  }, [report, effectiveCategoryId])

  const maxMinor = useMemo(() => {
    let max = 1
    for (const p of points) {
      max = Math.max(
        max,
        p.amountMinor,
        p.rollingAvgMinor,
        p.priorYearAmountMinor ?? 0,
        p.monthlyTargetMinor
      )
    }
    return max
  }, [points])

  const anomalies = useMemo(
    () => (report?.series ?? []).filter((p) => p.isAnomaly || p.isOverThreshold),
    [report]
  )

  const chartW = 720
  const chartH = 260
  const padL = 56
  const padR = 16
  const padT = 20
  const padB = 34
  const innerW = chartW - padL - padR
  const innerH = chartH - padT - padB

  const rollingPath = useMemo(() => {
    if (points.length === 0) return ''
    const step = innerW / Math.max(1, points.length)
    return points
      .map((p, idx) => {
        const x = padL + idx * step + step / 2
        const y = padT + innerH - (p.rollingAvgMinor / maxMinor) * innerH
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }, [points, innerW, innerH, maxMinor])

  return (
    <div data-testid="trends-panel" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-elevated p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium text-text-muted" htmlFor="trends-category-select">
            Category
          </label>
          <select
            id="trends-category-select"
            data-testid="trends-category-select"
            value={effectiveCategoryId}
            onChange={(e) => setSelectedCategoryId(e.target.value)}
            className="rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary"
          >
            {(report?.summaries ?? []).map((s) => (
              <option key={s.categoryId} value={s.categoryId}>
                {s.categoryName} ({formatMinorCurrency(s.totalAmountMinor)})
              </option>
            ))}
          </select>

          <div className="inline-flex rounded-lg border border-border bg-bg-secondary p-0.5">
            <button
              type="button"
              data-testid="trends-mode-mom"
              onClick={() => setComparisonMode('mom')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                comparisonMode === 'mom'
                  ? 'bg-accent text-on-accent'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              MoM + Rolling Avg
            </button>
            <button
              type="button"
              data-testid="trends-mode-yoy"
              onClick={() => setComparisonMode('yoy')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                comparisonMode === 'yoy'
                  ? 'bg-accent text-on-accent'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              YoY Comparison
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted" htmlFor="trends-rolling-window">
            Rolling Avg
          </label>
          <select
            id="trends-rolling-window"
            data-testid="trends-rolling-window"
            value={rollingWindow}
            onChange={(e) => onRollingWindowChange(Number(e.target.value))}
            className="rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
          >
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
          </select>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-elevated p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text-primary">
            Category Spending Trends ({comparisonMode.toUpperCase()})
          </h2>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-accent" /> Actual
            </span>
            {comparisonMode === 'mom' ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-0.5 w-3 bg-warning" /> {rollingWindow}m Rolling Avg
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-text-muted" /> Prior Year
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-negative" /> Over Threshold / Anomaly
            </span>
          </div>
        </div>

        {points.length === 0 ? (
          <div className="py-10 text-center text-sm text-text-muted">
            No category spending data for the selected filters.
          </div>
        ) : (
          <div className="w-full overflow-hidden">
            <svg
              data-testid="trends-svg"
              viewBox={`0 0 ${chartW} ${chartH}`}
              role="img"
              aria-label="Category spending trends chart"
              className="w-full h-auto max-h-[300px]"
            >
              {/* Horizontal grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
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
                      ${Math.round((maxMinor * frac) / 100)}
                    </text>
                  </g>
                )
              })}

              {/* Budget target line */}
              {points[0]?.monthlyTargetMinor > 0 && (
                <line
                  x1={padL}
                  x2={chartW - padR}
                  y1={padT + innerH - (points[0].monthlyTargetMinor / maxMinor) * innerH}
                  y2={padT + innerH - (points[0].monthlyTargetMinor / maxMinor) * innerH}
                  stroke="#fb7185"
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                />
              )}

              {/* Bars */}
              {points.map((point, idx) => {
                const slotW = innerW / Math.max(1, points.length)
                const barW = Math.min(34, Math.max(10, slotW * (comparisonMode === 'yoy' ? 0.36 : 0.55)))
                const cx = padL + idx * slotW + slotW / 2
                const h = Math.max(2, (point.amountMinor / maxMinor) * innerH)
                const y = padT + innerH - h
                const priorH =
                  point.priorYearAmountMinor !== null
                    ? Math.max(2, (point.priorYearAmountMinor / maxMinor) * innerH)
                    : 0
                const barX = comparisonMode === 'yoy' ? cx - barW - 1 : cx - barW / 2

                return (
                  <g key={point.period}>
                    {comparisonMode === 'yoy' && point.priorYearAmountMinor !== null && (
                      <rect
                        x={cx + 1}
                        y={padT + innerH - priorH}
                        width={barW}
                        height={priorH}
                        rx={3}
                        fill="#9a92b0"
                        fillOpacity={0.55}
                      />
                    )}
                    <rect
                      data-testid={`trend-bar-${point.categoryId}-${point.period}`}
                      x={barX}
                      y={y}
                      width={barW}
                      height={h}
                      rx={3}
                      fill={point.isAnomaly || point.isOverThreshold ? '#fb7185' : '#a855f7'}
                      className="cursor-pointer transition-opacity hover:opacity-80"
                      onClick={() =>
                        onDrilldown(
                          `${point.categoryName} — ${point.period}`,
                          point.amountMinor,
                          {
                            categoryId: point.categoryId,
                            period: point.period,
                            onlyTransfers: false,
                          }
                        )
                      }
                    />
                    <text
                      x={cx}
                      y={chartH - 12}
                      textAnchor="middle"
                      fontSize={10}
                      className="fill-text-muted font-mono"
                    >
                      {point.period.slice(2)}
                    </text>
                  </g>
                )
              })}

              {/* Rolling average overlay */}
              {comparisonMode === 'mom' && rollingPath && (
                <path
                  d={rollingPath}
                  fill="none"
                  stroke="#fbbf24"
                  strokeWidth={2.2}
                />
              )}
            </svg>
          </div>
        )}
      </div>

      {/* Anomaly & Budget Overage Badges */}
      <div className="rounded-xl border border-border bg-elevated p-4 space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Budget Threshold Overages & Spending Anomalies ({anomalies.length})
        </h3>
        {anomalies.length === 0 ? (
          <p className="text-xs text-text-muted">
            No budget overages or anomalies detected in this range.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {anomalies.map((item) => (
              <button
                key={`${item.categoryId}-${item.period}`}
                type="button"
                data-testid={`trend-anomaly-${item.categoryId}-${item.period}`}
                onClick={() =>
                  onDrilldown(
                    `${item.categoryName} — ${item.period}`,
                    item.amountMinor,
                    {
                      categoryId: item.categoryId,
                      period: item.period,
                      onlyTransfers: false,
                    }
                  )
                }
                className="flex flex-col gap-1 rounded-lg border border-negative-border bg-negative-subtle p-3 text-left transition-colors hover:bg-elevated-hover"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-text-primary">
                    {item.categoryName}
                  </span>
                  <span className="font-mono text-[11px] text-negative">{item.period}</span>
                </div>
                <div className="font-mono text-sm font-bold text-text-primary">
                  {formatMinorCurrency(item.amountMinor)}
                </div>
                <div className="text-[11px] text-text-secondary">
                  {item.isOverThreshold
                    ? `Over budget by ${formatMinorCurrency(item.overageMinor)}`
                    : `Above ${rollingWindow}m avg (${formatMinorCurrency(item.rollingAvgMinor)})`}
                  {item.yoyDeltaMinor !== null
                    ? ` · YoY ${item.yoyDeltaMinor >= 0 ? '+' : ''}${formatMinorCurrency(item.yoyDeltaMinor)}`
                    : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default CategoryTrendsChart
