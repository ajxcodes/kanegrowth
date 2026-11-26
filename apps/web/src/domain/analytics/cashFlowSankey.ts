import {
  isTransferTransaction,
  matchesFilterTransaction,
  resolveDateBounds,
} from './analyticsFilter'
import type {
  AnalyticsFilter,
  CashFlowSankeyGraph,
  CategoryRecord,
  EnvelopeType,
  LedgerSnapshot,
  SankeyLink,
  SankeyNode,
  SankeyNodeKind,
} from './types'

const pct = (part: number, total: number): number => {
  if (total <= 0) return 0
  return Math.round((part * 10000) / total) / 100
}

const layoutColumn = (
  nodes: SankeyNode[],
  x: number,
  availableHeight: number,
  gap: number,
  poolMinor: number
): void => {
  if (nodes.length === 0 || poolMinor <= 0) return
  const totalGaps = gap * Math.max(0, nodes.length - 1)
  const usableH = Math.max(40, availableHeight - totalGaps)
  let cursorY = 20
  for (const node of nodes) {
    const h = Math.max(12, usableH * (node.amountMinor / poolMinor))
    node.x = x
    node.y = cursorY
    node.height = h
    cursorY += h + gap
  }
}

export const computeCashFlowSankey = (
  snapshot: LedgerSnapshot,
  filter: AnalyticsFilter
): CashFlowSankeyGraph => {
  const [startDate, endDate] = resolveDateBounds(filter)
  const catMap = new Map<string, CategoryRecord>()
  for (const cat of snapshot.categories) {
    catMap.set(cat.id, cat)
  }

  const incomeByCat = new Map<string, { label: string; amount: number; count: number }>()
  const outflowByCat = new Map<
    string,
    { label: string; kind: SankeyNodeKind; amount: number; count: number }
  >()
  let transferTotalMinor = 0
  let transferTxCount = 0
  let excludedTransferMinor = 0

  for (const tx of snapshot.transactions) {
    if (!matchesFilterTransaction(filter, tx, startDate, endDate, false)) {
      continue
    }
    const amount = Math.abs(Math.trunc(tx.amountMinor))
    if (amount === 0) continue

    if (isTransferTransaction(tx)) {
      if (filter.includeTransfers) {
        transferTotalMinor += amount
        transferTxCount += 1
      } else {
        excludedTransferMinor += amount
      }
      continue
    }

    const cat = catMap.get(tx.categoryId)
    const catName = cat?.name ?? 'Uncategorized'
    const envType: EnvelopeType =
      cat?.envelopeType ?? (tx.txType === 'income' ? 'income' : 'expense')

    if (tx.txType === 'income') {
      if (filter.flowBasis === 'net' && envType !== 'income') {
        const kind: SankeyNodeKind =
          envType === 'sinking_fund'
            ? 'sinking_fund'
            : envType === 'savings'
              ? 'savings'
              : 'expense'
        const prev = outflowByCat.get(tx.categoryId) ?? {
          label: catName,
          kind,
          amount: 0,
          count: 0,
        }
        prev.amount -= amount
        prev.count += 1
        outflowByCat.set(tx.categoryId, prev)
      } else {
        const label = envType === 'income' ? catName : `${catName} (Refunds)`
        const prev = incomeByCat.get(tx.categoryId) ?? { label, amount: 0, count: 0 }
        prev.amount += amount
        prev.count += 1
        incomeByCat.set(tx.categoryId, prev)
      }
    } else if (tx.txType === 'expense') {
      const kind: SankeyNodeKind =
        envType === 'sinking_fund'
          ? 'sinking_fund'
          : envType === 'savings'
            ? 'savings'
            : 'expense'
      const prev = outflowByCat.get(tx.categoryId) ?? {
        label: catName,
        kind,
        amount: 0,
        count: 0,
      }
      prev.amount += amount
      prev.count += 1
      outflowByCat.set(tx.categoryId, prev)
    }
  }

  const cleanedOutflows: Array<{
    catId: string
    label: string
    kind: SankeyNodeKind
    amount: number
    count: number
  }> = []

  for (const [catId, entry] of outflowByCat.entries()) {
    if (entry.amount > 0) {
      cleanedOutflows.push({ catId, ...entry })
    } else if (entry.amount < 0) {
      const creditKey = `${catId}__credit`
      const prev = incomeByCat.get(creditKey) ?? {
        label: `${entry.label} (Net Credit)`,
        amount: 0,
        count: 0,
      }
      prev.amount += -entry.amount
      prev.count += entry.count
      incomeByCat.set(creditKey, prev)
    }
  }

  const incomeEntries = Array.from(incomeByCat.entries())
    .filter(([, v]) => v.amount > 0)
    .map(([catId, v]) => ({ catId, ...v }))
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))

  cleanedOutflows.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))

  const totalInflowMinor = incomeEntries.reduce((sum, e) => sum + e.amount, 0)
  const baseOutflowMinor = cleanedOutflows.reduce((sum, e) => sum + e.amount, 0)
  const totalOutflowMinor = baseOutflowMinor + transferTotalMinor
  const netSavingsMinor = totalInflowMinor - totalOutflowMinor
  const poolMinor = Math.max(totalInflowMinor, totalOutflowMinor)

  const tier0Nodes: SankeyNode[] = []
  const tier2Nodes: SankeyNode[] = []
  const links: SankeyLink[] = []

  for (const entry of incomeEntries) {
    const nodeId = `src_${entry.catId}`
    const sharePct = pct(entry.amount, poolMinor)
    tier0Nodes.push({
      id: nodeId,
      label: entry.label,
      tier: 0,
      kind: 'income',
      amountMinor: entry.amount,
      sharePct,
      txCount: entry.count,
      categoryId: entry.catId,
      x: 0,
      y: 0,
      width: 18,
      height: 0,
    })
    links.push({
      id: `link_${nodeId}_pool`,
      sourceId: nodeId,
      targetId: 'pool_household',
      amountMinor: entry.amount,
      sharePct,
      txCount: entry.count,
      categoryId: entry.catId,
      flowKind: 'income',
    })
  }

  if (totalOutflowMinor > totalInflowMinor) {
    const deficit = totalOutflowMinor - totalInflowMinor
    const sharePct = pct(deficit, poolMinor)
    tier0Nodes.push({
      id: 'src_deficit',
      label: 'Deficit / Balance Draw',
      tier: 0,
      kind: 'deficit',
      amountMinor: deficit,
      sharePct,
      txCount: 0,
      categoryId: null,
      x: 0,
      y: 0,
      width: 18,
      height: 0,
    })
    links.push({
      id: 'link_src_deficit_pool',
      sourceId: 'src_deficit',
      targetId: 'pool_household',
      amountMinor: deficit,
      sharePct,
      txCount: 0,
      categoryId: null,
      flowKind: 'deficit',
    })
  }

  for (const entry of cleanedOutflows) {
    const nodeId = `dst_${entry.catId}`
    const sharePct = pct(entry.amount, poolMinor)
    tier2Nodes.push({
      id: nodeId,
      label: entry.label,
      tier: 2,
      kind: entry.kind,
      amountMinor: entry.amount,
      sharePct,
      txCount: entry.count,
      categoryId: entry.catId,
      x: 0,
      y: 0,
      width: 18,
      height: 0,
    })
    links.push({
      id: `link_pool_${nodeId}`,
      sourceId: 'pool_household',
      targetId: nodeId,
      amountMinor: entry.amount,
      sharePct,
      txCount: entry.count,
      categoryId: entry.catId,
      flowKind: entry.kind,
    })
  }

  if (filter.includeTransfers && transferTotalMinor > 0) {
    const sharePct = pct(transferTotalMinor, poolMinor)
    tier2Nodes.push({
      id: 'dst_internal_transfers',
      label: 'Internal Transfers',
      tier: 2,
      kind: 'transfer',
      amountMinor: transferTotalMinor,
      sharePct,
      txCount: transferTxCount,
      categoryId: null,
      x: 0,
      y: 0,
      width: 18,
      height: 0,
    })
    links.push({
      id: 'link_pool_dst_internal_transfers',
      sourceId: 'pool_household',
      targetId: 'dst_internal_transfers',
      amountMinor: transferTotalMinor,
      sharePct,
      txCount: transferTxCount,
      categoryId: null,
      flowKind: 'transfer',
    })
  }

  if (totalInflowMinor > totalOutflowMinor) {
    const surplus = totalInflowMinor - totalOutflowMinor
    const sharePct = pct(surplus, poolMinor)
    tier2Nodes.push({
      id: 'dst_surplus',
      label: 'Unallocated Surplus',
      tier: 2,
      kind: 'surplus',
      amountMinor: surplus,
      sharePct,
      txCount: 0,
      categoryId: null,
      x: 0,
      y: 0,
      width: 18,
      height: 0,
    })
    links.push({
      id: 'link_pool_dst_surplus',
      sourceId: 'pool_household',
      targetId: 'dst_surplus',
      amountMinor: surplus,
      sharePct,
      txCount: 0,
      categoryId: null,
      flowKind: 'surplus',
    })
  }

  const canvasHeight = 320
  const gap = 12
  layoutColumn(tier0Nodes, 24, canvasHeight, gap, poolMinor)
  layoutColumn(tier2Nodes, 718, canvasHeight, gap, poolMinor)

  const nodes: SankeyNode[] = [...tier0Nodes]
  if (poolMinor > 0) {
    nodes.push({
      id: 'pool_household',
      label: 'Household Cash Pool',
      tier: 1,
      kind: 'pool',
      amountMinor: poolMinor,
      sharePct: 100,
      txCount: 0,
      categoryId: null,
      x: 371,
      y: 20,
      width: 18,
      height: canvasHeight,
    })
  }
  nodes.push(...tier2Nodes)

  return {
    nodes,
    links,
    totalInflowMinor,
    totalOutflowMinor,
    netSavingsMinor,
    excludedTransferMinor,
  }
}
