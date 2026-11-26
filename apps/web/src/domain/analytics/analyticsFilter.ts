import {
  InvalidFilterError,
  type AnalyticsFilter,
  type TransactionRecord,
} from './types'

export const createDefaultAnalyticsFilter = (asOfDate: string): AnalyticsFilter => ({
  dateRangePreset: 'this_month',
  startDate: null,
  endDate: null,
  asOfDate,
  accountIds: [],
  categoryIds: [],
  tagIds: [],
  memberIds: [],
  attributionMode: 'all',
  includeTransfers: false,
  flowBasis: 'net',
  workspaceId: null,
})

export const parseYmd = (date: string): [number, number, number] => {
  const slice = date.slice(0, 10)
  const parts = slice.split('-')
  if (parts.length !== 3) {
    throw new InvalidFilterError(`Invalid YYYY-MM-DD date: ${date}`)
  }
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) {
    throw new InvalidFilterError(`Out-of-range date: ${date}`)
  }
  return [y, m, d]
}

export const daysInMonth = (year: number, month: number): number => {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31
  if ([4, 6, 9, 11].includes(month)) return 30
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  }
  return 30
}

export const addMonths = (year: number, month: number, delta: number): [number, number] => {
  const total = year * 12 + (month - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = ((total % 12) + 12) % 12 + 1
  return [ny, nm]
}

export const formatYm = (year: number, month: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`

export const monthSequence = (startYm: string, endYm: string): string[] => {
  const [sy, sm] = parseYmd(`${startYm}-01`)
  const [ey, em] = parseYmd(`${endYm}-01`)
  const out: string[] = []
  let cy = sy
  let cm = sm
  while (cy < ey || (cy === ey && cm <= em)) {
    out.push(formatYm(cy, cm))
    const [ny, nm] = addMonths(cy, cm, 1)
    cy = ny
    cm = nm
    if (out.length > 600) break
  }
  return out
}

export const resolveDateBounds = (filter: AnalyticsFilter): [string, string] => {
  const [year, month] = parseYmd(filter.asOfDate)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const pad4 = (n: number) => String(n).padStart(4, '0')

  switch (filter.dateRangePreset) {
    case 'this_month':
      return [
        `${pad4(year)}-${pad2(month)}-01`,
        `${pad4(year)}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
      ]
    case 'last_month': {
      const [py, pm] = addMonths(year, month, -1)
      return [
        `${pad4(py)}-${pad2(pm)}-01`,
        `${pad4(py)}-${pad2(pm)}-${pad2(daysInMonth(py, pm))}`,
      ]
    }
    case 'ytd':
      return [
        `${pad4(year)}-01-01`,
        `${pad4(year)}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
      ]
    case 'last_12_months': {
      const [sy, sm] = addMonths(year, month, -11)
      return [
        `${pad4(sy)}-${pad2(sm)}-01`,
        `${pad4(year)}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
      ]
    }
    case 'custom': {
      if (!filter.startDate || !filter.endDate) {
        throw new InvalidFilterError('Custom range requires startDate and endDate')
      }
      parseYmd(filter.startDate)
      parseYmd(filter.endDate)
      if (filter.startDate > filter.endDate) {
        throw new InvalidFilterError('startDate must be <= endDate')
      }
      return [filter.startDate, filter.endDate]
    }
  }
}

export const isTransferTransaction = (tx: TransactionRecord): boolean =>
  tx.txType === 'transfer' || tx.transferPairId !== null

export const matchesFilterDimensions = (
  filter: AnalyticsFilter,
  tx: TransactionRecord,
  respectTransferFlag: boolean
): boolean => {
  if (tx.hasSplitChildren || tx.status === 'draft') {
    return false
  }
  if (respectTransferFlag && !filter.includeTransfers && isTransferTransaction(tx)) {
    return false
  }
  if (filter.accountIds.length > 0 && !filter.accountIds.includes(tx.accountId)) {
    return false
  }
  if (filter.categoryIds.length > 0 && !filter.categoryIds.includes(tx.categoryId)) {
    return false
  }
  if (filter.tagIds.length > 0 && !filter.tagIds.some((tid) => tx.tagIds.includes(tid))) {
    return false
  }
  if (filter.memberIds.length > 0 && (!tx.memberId || !filter.memberIds.includes(tx.memberId))) {
    return false
  }
  if (filter.attributionMode === 'shared' && !tx.isShared) {
    return false
  }
  if (filter.attributionMode === 'individual' && tx.isShared) {
    return false
  }
  return true
}

export const matchesFilterTransaction = (
  filter: AnalyticsFilter,
  tx: TransactionRecord,
  startDate: string,
  endDate: string,
  respectTransferFlag: boolean
): boolean => {
  if (!matchesFilterDimensions(filter, tx, respectTransferFlag)) {
    return false
  }
  const d = tx.date.slice(0, 10)
  return d >= startDate && d <= endDate
}
