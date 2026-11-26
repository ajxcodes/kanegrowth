import type { CSSProperties } from 'react'
import type { XAxisProps, YAxisProps } from 'recharts'
import { formatCurrency, getCurrencySymbol } from '@lib/format'

export const CHART_COLORS = {
    income: '#4ade80',
    expense: '#fb7185',
    net: '#d4af37',
    grid: '#334c42',
    axis: '#9c9583',
    tooltipBg: '#223530',
    tooltipBorder: '#334c42',
    tooltipLabel: '#c9c3ae',
    tooltipValue: '#f5f1e4',
} as const

export const LIGHT_CHART_COLORS = {
    income: '#15803d',
    expense: '#be123c',
    net: '#8a6a12',
    grid: '#d6cfb8',
    axis: '#47584e',
    tooltipBg: '#ffffff',
    tooltipBorder: '#d6cfb8',
    tooltipLabel: '#34463c',
    tooltipValue: '#14201a',
} as const

export const getThemeChartColors = (theme: 'dark' | 'light') =>
    theme === 'light' ? LIGHT_CHART_COLORS : CHART_COLORS

export const CHART_CATEGORY_COLORS = [
    '#d4af37',
    '#4ade80',
    '#34d399',
    '#a3e635',
    '#fbbf24',
    '#fb7185',
    '#38bdf8',
    '#f97316',
    '#e5c458',
    '#22c55e',
]

export const chartMargin = { top: 8, right: 12, left: 0, bottom: 0 }

export const chartTooltipContentStyle: CSSProperties = {
    backgroundColor: CHART_COLORS.tooltipBg,
    border: `1px solid ${CHART_COLORS.tooltipBorder}`,
    borderRadius: '0.75rem',
    color: CHART_COLORS.tooltipValue,
    fontSize: '0.75rem',
}

export const chartTooltipLabelStyle: CSSProperties = {
    color: CHART_COLORS.tooltipLabel,
    fontWeight: 500,
    marginBottom: 4,
}

export const chartTooltipItemStyle: CSSProperties = {
    color: CHART_COLORS.tooltipValue,
}

/** Tooltip props for bar charts - hides the default hover highlight band */
export const barChartTooltipProps = {
    contentStyle: chartTooltipContentStyle,
    labelStyle: chartTooltipLabelStyle,
    itemStyle: chartTooltipItemStyle,
    cursor: false as const,
}

export const chartTooltipProps = {
    contentStyle: chartTooltipContentStyle,
    labelStyle: chartTooltipLabelStyle,
    itemStyle: chartTooltipItemStyle,
}

export const axisTick: XAxisProps['tick'] = { fill: CHART_COLORS.axis, fontSize: 11 }
export const yAxisTick: YAxisProps['tick'] = { fill: CHART_COLORS.axis, fontSize: 11 }

export const formatPeriodLabel = (period: string, groupBy: 'day' | 'week' | 'month'): string => {
    if (groupBy === 'month') {
        const [year, month] = period.split('-')
        const date = new Date(Number(year), Number(month) - 1, 1)
        return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    }

    if (groupBy === 'week') {
        return period.replace('-W', ' W')
    }

    const date = new Date(`${period}T12:00:00`)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export interface ChartSeriesDef {
    key: string
    label: string
}

/**
 * Builds a plain-text accessible summary of a time-series chart's data, for use as the
 * `aria-label` on a `role="img"` wrapper - screen readers get no information from the underlying
 * SVG, so this is the text alternative. Points beyond MAX_POINTS collapse to a per-series total
 * (an aria-label enumerating a full year of daily data would be unusably long).
 */
export const summarizeChartSeries = (
    data: Record<string, unknown>[],
    series: ChartSeriesDef[],
    labelKey = 'label'
): string => {
    if (data.length === 0) return 'No data for this period.'

    const MAX_POINTS = 24
    if (data.length > MAX_POINTS) {
        const totals = series.map((s) => {
            const total = data.reduce((sum, point) => sum + (Number(point[s.key]) || 0), 0)
            return `${s.label} total ${formatCurrency(total)}`
        })
        return `${data.length} periods from ${String(data[0][labelKey])} to ${String(data[data.length - 1][labelKey])}. ${totals.join(', ')}.`
    }

    return data
        .map((point) => {
            const parts = series.map((s) => `${s.label} ${formatCurrency(Number(point[s.key]) || 0)}`)
            return `${String(point[labelKey])}: ${parts.join(', ')}`
        })
        .join('; ')
}

export const formatChartCurrency = (value: number): string => {
    const symbol = getCurrencySymbol()
    if (Math.abs(value) >= 1000) {
        return `${symbol}${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`
    }
    return `${symbol}${value}`
}
