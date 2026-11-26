import React, { useMemo, useState } from 'react'
import type {
  AnalyticsFilter,
  CashFlowSankeyGraph,
  DrilldownCriteria,
  FlowBasis,
  SankeyLink,
  SankeyNode,
  SankeyNodeKind,
} from '@domain/analytics/types'
import { formatMinorCurrency } from '../hooks/useAnalyticsData'

interface CashFlowSankeyChartProps {
  graph: CashFlowSankeyGraph | null
  filter: AnalyticsFilter
  onFilterChange: (updater: (prev: AnalyticsFilter) => AnalyticsFilter) => void
  onDrilldown: (title: string, expectedMinor: number | null, criteria: DrilldownCriteria) => void
}

const NODE_COLORS: Record<SankeyNodeKind, string> = {
  income: '#4ade80',
  pool: '#a855f7',
  expense: '#fb7185',
  sinking_fund: '#38bdf8',
  savings: '#34d399',
  transfer: '#fbbf24',
  surplus: '#818cf8',
  deficit: '#f97316',
}

const CashFlowSankeyChart: React.FC<CashFlowSankeyChartProps> = ({
  graph,
  filter,
  onFilterChange,
  onDrilldown,
}) => {
  const [hoveredText, setHoveredText] = useState<string | null>(null)

  const nodeMap = useMemo(() => {
    const map = new Map<string, SankeyNode>()
    for (const n of graph?.nodes ?? []) {
      map.set(n.id, n)
    }
    return map
  }, [graph])

  // Compute stacked Bezier ribbons connecting Tier-0 -> Pool -> Tier-2
  const linkPaths = useMemo(() => {
    if (!graph) return []
    const pool = nodeMap.get('pool_household')
    if (!pool || pool.amountMinor <= 0) return []

    let leftPoolY = pool.y
    let rightPoolY = pool.y

    return graph.links
      .map((link) => {
        const src = nodeMap.get(link.sourceId)
        const dst = nodeMap.get(link.targetId)
        if (!src || !dst) return null

        const thickness = Math.max(4, (link.amountMinor / pool.amountMinor) * pool.height)
        let x0: number
        let y0: number
        let x1: number
        let y1: number

        if (src.tier === 0) {
          x0 = src.x + src.width
          y0 = src.y + src.height / 2
          x1 = dst.x
          y1 = leftPoolY + thickness / 2
          leftPoolY += thickness
        } else {
          x0 = src.x + src.width
          y0 = rightPoolY + thickness / 2
          x1 = dst.x
          y1 = dst.y + dst.height / 2
          rightPoolY += thickness
        }

        const midX = (x0 + x1) / 2
        const d = `M ${x0} ${y0} C ${midX} ${y0}, ${midX} ${y1}, ${x1} ${y1}`
        return { link, d, thickness, color: NODE_COLORS[link.flowKind] }
      })
      .filter((item): item is { link: SankeyLink; d: string; thickness: number; color: string } => item !== null)
  }, [graph, nodeMap])

  const handleNodeOrLinkClick = (
    label: string,
    amountMinor: number,
    categoryId: string | null,
    kind: SankeyNodeKind
  ) => {
    if (kind === 'pool' || kind === 'surplus' || kind === 'deficit') return
    onDrilldown(label, amountMinor, {
      categoryId: kind === 'transfer' ? null : categoryId,
      period: null,
      onlyTransfers: kind === 'transfer',
    })
  }

  return (
    <div data-testid="sankey-panel" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-elevated p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 flex-1 min-w-0">
          <div>
            <div className="text-[11px] uppercase text-text-muted">Total Inflow</div>
            <div data-testid="sankey-total-inflow" className="font-mono text-sm font-semibold text-positive">
              {formatMinorCurrency(graph?.totalInflowMinor ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-text-muted">Total Outflow</div>
            <div data-testid="sankey-total-outflow" className="font-mono text-sm font-semibold text-negative">
              {formatMinorCurrency(graph?.totalOutflowMinor ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-text-muted">Net Surplus</div>
            <div data-testid="sankey-net-savings" className="font-mono text-sm font-semibold text-text-primary">
              {formatMinorCurrency(graph?.netSavingsMinor ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-text-muted">Excluded Transfers</div>
            <div data-testid="sankey-excluded-transfers" className="font-mono text-sm font-semibold text-warning">
              {formatMinorCurrency(graph?.excludedTransferMinor ?? 0)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              data-testid="sankey-exclude-transfers-toggle"
              checked={!filter.includeTransfers}
              onChange={(e) =>
                onFilterChange((prev) => ({
                  ...prev,
                  includeTransfers: !e.target.checked,
                }))
              }
              className="rounded border-border accent-accent"
            />
            Exclude Internal Transfers
          </label>

          <div className="inline-flex rounded-lg border border-border bg-bg-secondary p-0.5">
            {(['net', 'gross'] as FlowBasis[]).map((basis) => (
              <button
                key={basis}
                type="button"
                data-testid={`sankey-basis-${basis}`}
                onClick={() => onFilterChange((prev) => ({ ...prev, flowBasis: basis }))}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                  filter.flowBasis === basis
                    ? 'bg-accent text-on-accent'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {basis}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-elevated p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text-primary">
            Household Cash Flow Sankey
          </h2>
          <span
            data-testid="sankey-hover-tooltip"
            className="text-xs text-text-muted min-h-[1rem]"
          >
            {hoveredText ?? 'Hover any node or flow; click a category to inspect transactions'}
          </span>
        </div>

        {!graph || graph.nodes.length === 0 ? (
          <div className="py-12 text-center text-sm text-text-muted">
            No matching cash flow activity for the selected filters.
          </div>
        ) : (
          <div className="w-full overflow-hidden">
            <svg
              data-testid="sankey-svg"
              viewBox="0 0 760 360"
              role="img"
              aria-label="Household cash flow Sankey diagram"
              className="w-full h-auto max-h-[380px] select-none"
            >
              {linkPaths.map(({ link, d, thickness, color }) => {
                const dst = nodeMap.get(link.targetId)
                const src = nodeMap.get(link.sourceId)
                const label = link.sourceId === 'pool_household' ? (dst?.label ?? link.id) : (src?.label ?? link.id)
                return (
                  <path
                    key={link.id}
                    data-testid={`sankey-link-${link.id}`}
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.38}
                    strokeWidth={thickness}
                    className="cursor-pointer transition-opacity hover:stroke-opacity-75"
                    onMouseEnter={() =>
                      setHoveredText(
                        `${label}: ${formatMinorCurrency(link.amountMinor)} (${link.sharePct.toFixed(1)}%)`
                      )
                    }
                    onMouseLeave={() => setHoveredText(null)}
                    onClick={() =>
                      handleNodeOrLinkClick(label, link.amountMinor, link.categoryId, link.flowKind)
                    }
                  />
                )
              })}

              {graph.nodes.map((node) => {
                const isClickable =
                  node.kind !== 'pool' && node.kind !== 'surplus' && node.kind !== 'deficit'
                const labelX =
                  node.tier === 0
                    ? node.x + node.width + 8
                    : node.tier === 2
                      ? node.x - 8
                      : node.x + node.width / 2
                const anchor =
                  node.tier === 0 ? 'start' : node.tier === 2 ? 'end' : 'middle'
                return (
                  <g
                    key={node.id}
                    data-testid={`sankey-node-${node.id}`}
                    className={isClickable ? 'cursor-pointer' : ''}
                    onMouseEnter={() =>
                      setHoveredText(
                        `${node.label}: ${formatMinorCurrency(node.amountMinor)} (${node.sharePct.toFixed(1)}%)`
                      )
                    }
                    onMouseLeave={() => setHoveredText(null)}
                    onClick={() =>
                      handleNodeOrLinkClick(
                        node.label,
                        node.amountMinor,
                        node.categoryId,
                        node.kind
                      )
                    }
                  >
                    <rect
                      x={node.x}
                      y={node.y}
                      width={node.width}
                      height={node.height}
                      rx={4}
                      fill={NODE_COLORS[node.kind]}
                    />
                    <text
                      x={labelX}
                      y={node.tier === 1 ? node.y - 6 : node.y + node.height / 2 + 4}
                      textAnchor={anchor}
                      fontSize={11}
                      fill="currentColor"
                      className="fill-text-primary font-medium"
                    >
                      {node.label} ({formatMinorCurrency(node.amountMinor)})
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
        )}
      </div>
    </div>
  )
}

export default CashFlowSankeyChart
