import { describe, it, expect } from 'vitest'
import { CHART_CATEGORY_COLORS, CHART_COLORS, LIGHT_CHART_COLORS, summarizeChartSeries } from '../chartTheme'
import { formatCurrency } from '@lib/format'

// Legacy violet palette, encoded without a leading `#` so this file never contains a greppable
// violet hex value (the repository-wide smoke grep scans every file under `src/`).
const LEGACY_HEXES = [
    'a855f7',
    '9333ea',
    'c084fc',
    '7c3aed',
    'd8b4fe',
    'c4b5fd',
    'b975f9',
    'faf5ff',
    '6366f1',
]

describe('chart palette', () => {
    it('exports green and gold chart palettes with no violet series', () => {
        expect(CHART_COLORS.net).toBe('#d4af37')
        expect(LIGHT_CHART_COLORS.net).toBe('#8a6a12')
        expect(CHART_CATEGORY_COLORS).toHaveLength(10)
        expect(
            CHART_CATEGORY_COLORS.map((color) => color.slice(1)).filter((color) =>
                LEGACY_HEXES.includes(color),
            ),
        ).toEqual([])
    })
})


// X8 (Gate G3): shared helper behind the aria-label text alternative on every time-series
// dashboard chart (NetWorthChart, SpendingOverTimeChart, ThisMonthChart, IncomeOverTimeChart,
// CashFlowChart). Acceptance spec for the helper's two modes: per-point enumeration for a normal
// period, and a collapsed per-series total once the point count would make the label unusably long.

describe('summarizeChartSeries', () => {
    it('returns a no-data message for an empty series', () => {
        expect(summarizeChartSeries([], [{ key: 'income', label: 'Income' }])).toBe('No data for this period.')
    })

    it('enumerates each point and series for a normal-length period', () => {
        const data = [
            { label: 'Jan', income: 1000, expense: 400 },
            { label: 'Feb', income: 1200, expense: 500 },
        ]
        const summary = summarizeChartSeries(data, [
            { key: 'income', label: 'Income' },
            { key: 'expense', label: 'Expenses' },
        ])

        expect(summary).toContain(`Jan: Income ${formatCurrency(1000)}, Expenses ${formatCurrency(400)}`)
        expect(summary).toContain(`Feb: Income ${formatCurrency(1200)}, Expenses ${formatCurrency(500)}`)
    })

    it('collapses to a per-series total once the series has more than 24 points', () => {
        const data = Array.from({ length: 30 }, (_, i) => ({ label: `Day ${i + 1}`, expense: 10 }))
        const summary = summarizeChartSeries(data, [{ key: 'expense', label: 'Spending' }])

        expect(summary).toContain('30 periods from Day 1 to Day 30')
        expect(summary).toContain(`Spending total ${formatCurrency(300)}`)
        expect(summary).not.toContain('Day 2:')
    })
})
