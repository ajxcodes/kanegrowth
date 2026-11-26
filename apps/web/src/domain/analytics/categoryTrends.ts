import {
  addMonths,
  formatYm,
  matchesFilterDimensions,
  monthSequence,
  parseYmd,
  resolveDateBounds,
} from './analyticsFilter'
import type {
  AnalyticsFilter,
  CategoryRecord,
  CategoryTrendPoint,
  CategoryTrendsReport,
  CategoryTrendSummary,
  LedgerSnapshot,
} from './types'

const pctDelta = (delta: number, base: number): number | null => {
  if (base <= 0) return null
  return Math.round((delta * 10000) / base) / 100
}

export const computeCategoryTrends = (
  snapshot: LedgerSnapshot,
  filter: AnalyticsFilter,
  rollingWindow = 3
): CategoryTrendsReport => {
  const window = Math.max(1, Math.trunc(rollingWindow))
  const [startDate, endDate] = resolveDateBounds(filter)
  const periods = monthSequence(startDate.slice(0, 7), endDate.slice(0, 7))

  const catMap = new Map<string, CategoryRecord>()
  for (const cat of snapshot.categories) {
    catMap.set(cat.id, cat)
  }

  const totals = new Map<string, { amount: number; count: number }>()
  const activeCategories = new Map<string, CategoryRecord>()

  for (const tx of snapshot.transactions) {
    if (!matchesFilterDimensions(filter, tx, true)) continue
    const cat = catMap.get(tx.categoryId)
    if (!cat || cat.envelopeType === 'income' || cat.envelopeType === 'transfer') continue
    const ym = tx.date.slice(0, 7)
    if (ym.length !== 7) continue

    const amt = Math.abs(Math.trunc(tx.amountMinor))
    let signed = 0
    if (tx.txType === 'expense') signed = amt
    else if (tx.txType === 'income' && filter.flowBasis === 'net') signed = -amt
    if (signed === 0) continue

    const key = `${cat.id}::${ym}`
    const prev = totals.get(key) ?? { amount: 0, count: 0 }
    prev.amount += signed
    prev.count += 1
    totals.set(key, prev)
    activeCategories.set(cat.id, cat)
  }

  for (const cid of filter.categoryIds) {
    const cat = catMap.get(cid)
    if (cat && cat.envelopeType !== 'income' && cat.envelopeType !== 'transfer') {
      activeCategories.set(cat.id, cat)
    }
  }

  const series: CategoryTrendPoint[] = []
  const summaries: CategoryTrendSummary[] = []

  const sortedCategories = Array.from(activeCategories.values()).sort((a, b) =>
    a.id.localeCompare(b.id)
  )

  for (const cat of sortedCategories) {
    let totalInRange = 0
    let latestAmount = 0
    let anomalyCount = 0
    let overageCount = 0

    for (const period of periods) {
      const [py, pm] = parseYmd(`${period}-01`)
      const current = totals.get(`${cat.id}::${period}`)
      const amountMinor = Math.max(0, current?.amount ?? 0)
      const txCount = current?.count ?? 0
      totalInRange += amountMinor
      latestAmount = amountMinor

      let rollingSum = 0
      let rollingCount = 0
      for (let offset = 1; offset <= window; offset += 1) {
        const [ry, rm] = addMonths(py, pm, -offset)
        const entry = totals.get(`${cat.id}::${formatYm(ry, rm)}`)
        if (entry) {
          rollingSum += Math.max(0, entry.amount)
          rollingCount += 1
        }
      }
      const rollingAvgMinor =
        rollingCount > 0 ? Math.floor((rollingSum + Math.floor(rollingCount / 2)) / rollingCount) : 0

      const [prevY, prevM] = addMonths(py, pm, -1)
      const prevEntry = totals.get(`${cat.id}::${formatYm(prevY, prevM)}`)
      const momDeltaMinor = prevEntry ? amountMinor - Math.max(0, prevEntry.amount) : null
      const momDeltaPct =
        prevEntry && momDeltaMinor !== null
          ? pctDelta(momDeltaMinor, Math.max(0, prevEntry.amount))
          : null

      const priorYearEntry = totals.get(`${cat.id}::${formatYm(py - 1, pm)}`)
      const priorYearAmountMinor = priorYearEntry ? Math.max(0, priorYearEntry.amount) : null
      const yoyDeltaMinor =
        priorYearAmountMinor !== null ? amountMinor - priorYearAmountMinor : null
      const yoyDeltaPct =
        priorYearAmountMinor !== null && yoyDeltaMinor !== null
          ? pctDelta(yoyDeltaMinor, priorYearAmountMinor)
          : null

      const target = Math.max(0, Math.trunc(cat.monthlyTargetMinor))
      const overageMinor = target > 0 && amountMinor > target ? amountMinor - target : 0
      const isOverThreshold = target > 0 && amountMinor > target
      const isAnomaly =
        isOverThreshold || (rollingAvgMinor > 0 && amountMinor * 100 > rollingAvgMinor * 125)

      if (isOverThreshold) overageCount += 1
      if (isAnomaly) anomalyCount += 1

      series.push({
        period,
        categoryId: cat.id,
        categoryName: cat.name,
        amountMinor,
        rollingAvgMinor,
        momDeltaMinor,
        momDeltaPct,
        priorYearAmountMinor,
        yoyDeltaMinor,
        yoyDeltaPct,
        monthlyTargetMinor: target,
        overageMinor,
        isOverThreshold,
        isAnomaly,
        txCount,
      })
    }

    summaries.push({
      categoryId: cat.id,
      categoryName: cat.name,
      totalAmountMinor: totalInRange,
      latestAmountMinor: latestAmount,
      monthlyTargetMinor: Math.max(0, Math.trunc(cat.monthlyTargetMinor)),
      anomalyCount,
      overageCount,
    })
  }

  summaries.sort(
    (a, b) => b.totalAmountMinor - a.totalAmountMinor || a.categoryName.localeCompare(b.categoryName)
  )

  return {
    periods,
    series,
    summaries,
    rollingWindow: window,
  }
}
