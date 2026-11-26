import {
  addMonths,
  formatYm,
  matchesFilterDimensions,
  monthSequence,
  parseYmd,
  resolveDateBounds,
} from './analyticsFilter'
import {
  NonAmortizingDebtError,
  type AccountGroup,
  type AnalyticsFilter,
  type DebtAccountInput,
  type DebtPayoffComparison,
  type DebtPayoffMonthPoint,
  type DebtPayoffOptions,
  type DebtPayoffSummary,
  type LedgerSnapshot,
  type NetWorthAndDebtReport,
  type NetWorthPoint,
  type PayoffStrategy,
} from './types'

const MAX_MONTHS = 600

export const monthlyInterestMinor = (balanceMinor: number, interestRateBps: number): number => {
  if (balanceMinor <= 0 || interestRateBps <= 0) return 0
  return Math.floor((balanceMinor * interestRateBps + 60_000) / 120_000)
}

const sortDebtIndices = (debts: DebtAccountInput[], strategy: PayoffStrategy): number[] => {
  const indices = debts.map((_, i) => i)
  if (strategy === 'snowball') {
    indices.sort(
      (a, b) =>
        debts[a].balanceMinor - debts[b].balanceMinor ||
        debts[b].interestRateBps - debts[a].interestRateBps ||
        debts[a].id.localeCompare(debts[b].id)
    )
  } else {
    indices.sort(
      (a, b) =>
        debts[b].interestRateBps - debts[a].interestRateBps ||
        debts[a].balanceMinor - debts[b].balanceMinor ||
        debts[a].id.localeCompare(debts[b].id)
    )
  }
  return indices
}

interface SimRun {
  targetOrder: string[]
  debtFreeMonths: number
  totalInterestPaidMinor: number
  totalPaidMinor: number
  schedule: DebtPayoffMonthPoint[]
}

const simulateSingle = (
  debts: DebtAccountInput[],
  strategy: PayoffStrategy,
  extraMonthlyMinor: number,
  lumpSumMinor: number,
  asOfDate: string
): SimRun => {
  const [startY, startM] = parseYmd(asOfDate)
  const active = debts.filter((d) => d.balanceMinor > 0)
  if (active.length === 0) {
    return {
      targetOrder: [],
      debtFreeMonths: 0,
      totalInterestPaidMinor: 0,
      totalPaidMinor: 0,
      schedule: [],
    }
  }

  const order = sortDebtIndices(active, strategy)
  const targetOrder = order.map((i) => active[i].id)
  const balances = active.map((d) => Math.trunc(d.balanceMinor))
  const totalMin = active.reduce((sum, d) => sum + Math.max(0, Math.trunc(d.minimumPaymentMinor)), 0)
  const monthlyBudget = totalMin + Math.max(0, Math.trunc(extraMonthlyMinor))

  let totalPaidMinor = 0
  let remainingLump = Math.max(0, Math.trunc(lumpSumMinor))
  for (const idx of order) {
    if (remainingLump <= 0) break
    const applied = Math.min(remainingLump, balances[idx])
    balances[idx] -= applied
    remainingLump -= applied
    totalPaidMinor += applied
  }

  if (balances.every((b) => b === 0)) {
    return {
      targetOrder,
      debtFreeMonths: 0,
      totalInterestPaidMinor: 0,
      totalPaidMinor,
      schedule: [],
    }
  }

  let totalInterestPaidMinor = 0
  const schedule: DebtPayoffMonthPoint[] = []
  let month = 0

  while (balances.some((b) => b > 0)) {
    month += 1
    if (month > MAX_MONTHS) {
      throw new NonAmortizingDebtError(`Payoff exceeds maximum horizon of ${MAX_MONTHS} months`)
    }

    const startTotal = balances.reduce((s, b) => s + b, 0)
    let monthInterest = 0

    for (let i = 0; i < active.length; i += 1) {
      if (balances[i] > 0) {
        const interest = monthlyInterestMinor(balances[i], active[i].interestRateBps)
        balances[i] += interest
        monthInterest += interest
      }
    }

    let remainingBudget = monthlyBudget
    let monthPaid = 0

    for (let i = 0; i < active.length; i += 1) {
      if (balances[i] <= 0 || remainingBudget <= 0) continue
      const minPay = Math.min(Math.max(0, Math.trunc(active[i].minimumPaymentMinor)), balances[i], remainingBudget)
      balances[i] -= minPay
      remainingBudget -= minPay
      monthPaid += minPay
    }

    for (const idx of order) {
      if (remainingBudget <= 0) break
      if (balances[idx] <= 0) continue
      const extra = Math.min(remainingBudget, balances[idx])
      balances[idx] -= extra
      remainingBudget -= extra
      monthPaid += extra
    }

    const endTotal = balances.reduce((s, b) => s + b, 0)
    const principalReduction = startTotal - endTotal
    if (endTotal > 0 && principalReduction <= 0) {
      throw new NonAmortizingDebtError('Monthly payments do not exceed accrued interest')
    }

    totalInterestPaidMinor += monthInterest
    totalPaidMinor += monthPaid
    const [py, pm] = addMonths(startY, startM, month)
    schedule.push({
      monthIndex: month,
      period: formatYm(py, pm),
      remainingBalanceMinor: endTotal,
      interestPaidMinor: monthInterest,
      principalPaidMinor: Math.max(0, principalReduction),
    })
  }

  return {
    targetOrder,
    debtFreeMonths: month,
    totalInterestPaidMinor,
    totalPaidMinor,
    schedule,
  }
}

export const compareDebtPayoffStrategies = (
  debts: DebtAccountInput[],
  options: DebtPayoffOptions,
  asOfDate: string
): DebtPayoffComparison => {
  const [startY, startM] = parseYmd(asOfDate)
  const snowballBase = simulateSingle(debts, 'snowball', 0, 0, asOfDate)
  const avalancheBase = simulateSingle(debts, 'avalanche', 0, 0, asOfDate)
  const snowballRun = simulateSingle(
    debts,
    'snowball',
    options.extraMonthlyMinor,
    options.lumpSumMinor,
    asOfDate
  )
  const avalancheRun = simulateSingle(
    debts,
    'avalanche',
    options.extraMonthlyMinor,
    options.lumpSumMinor,
    asOfDate
  )

  const makeDate = (months: number): string => {
    const [y, m] = addMonths(startY, startM, months)
    return formatYm(y, m)
  }

  const snowball: DebtPayoffSummary = {
    strategy: 'snowball',
    targetOrder: snowballRun.targetOrder,
    debtFreeMonths: snowballRun.debtFreeMonths,
    debtFreeDate: makeDate(snowballRun.debtFreeMonths),
    totalInterestPaidMinor: snowballRun.totalInterestPaidMinor,
    totalPaidMinor: snowballRun.totalPaidMinor,
    baselineInterestMinor: snowballBase.totalInterestPaidMinor,
    interestSavedVsMinimumMinor: Math.max(
      0,
      snowballBase.totalInterestPaidMinor - snowballRun.totalInterestPaidMinor
    ),
    schedule: snowballRun.schedule,
  }

  const avalanche: DebtPayoffSummary = {
    strategy: 'avalanche',
    targetOrder: avalancheRun.targetOrder,
    debtFreeMonths: avalancheRun.debtFreeMonths,
    debtFreeDate: makeDate(avalancheRun.debtFreeMonths),
    totalInterestPaidMinor: avalancheRun.totalInterestPaidMinor,
    totalPaidMinor: avalancheRun.totalPaidMinor,
    baselineInterestMinor: avalancheBase.totalInterestPaidMinor,
    interestSavedVsMinimumMinor: Math.max(
      0,
      avalancheBase.totalInterestPaidMinor - avalancheRun.totalInterestPaidMinor
    ),
    schedule: avalancheRun.schedule,
  }

  return {
    snowball,
    avalanche,
    interestSavedByAvalancheMinor: Math.max(
      0,
      snowball.totalInterestPaidMinor - avalanche.totalInterestPaidMinor
    ),
    extraPaymentInterestSavedMinor: avalanche.interestSavedVsMinimumMinor,
  }
}

const emptyGroupMap = (): Record<AccountGroup, number> => ({
  banking: 0,
  investment: 0,
  cash: 0,
  credit: 0,
  loan: 0,
})

export const computeNetWorthAndDebt = (
  snapshot: LedgerSnapshot,
  filter: AnalyticsFilter,
  options: DebtPayoffOptions = { extraMonthlyMinor: 0, lumpSumMinor: 0, projectionMonths: 24 }
): NetWorthAndDebtReport => {
  const [startDate, endDate] = resolveDateBounds(filter)
  const periods = monthSequence(startDate.slice(0, 7), endDate.slice(0, 7))

  const filteredAccounts = snapshot.accounts.filter(
    (a) => filter.accountIds.length === 0 || filter.accountIds.includes(a.id)
  )

  const monthlyDeltas = new Map<string, number>()
  for (const tx of snapshot.transactions) {
    if (!matchesFilterDimensions(filter, tx, true)) continue
    const ym = tx.date.slice(0, 7)
    const amt = Math.abs(Math.trunc(tx.amountMinor))
    const acc = filteredAccounts.find((a) => a.id === tx.accountId)
    const isLiab = acc?.isLiability ?? false
    let delta = 0
    if (tx.txType === 'income' && !isLiab) delta = amt
    else if (tx.txType === 'expense' && !isLiab) delta = -amt
    else if (tx.txType === 'expense' && isLiab) delta = amt
    else if (tx.txType === 'income' && isLiab) delta = -amt
    if (delta !== 0) {
      const key = `${tx.accountId}::${ym}`
      monthlyDeltas.set(key, (monthlyDeltas.get(key) ?? 0) + delta)
    }
  }

  const runningBalances = new Map<string, number>()
  for (const acc of filteredAccounts) {
    runningBalances.set(acc.id, Math.trunc(acc.currentBalanceMinor))
  }

  const timeline: NetWorthPoint[] = []
  for (let i = periods.length - 1; i >= 0; i -= 1) {
    const period = periods[i]
    let assetsMinor = 0
    let liabilitiesMinor = 0
    const byAccountGroup = emptyGroupMap()

    for (const acc of filteredAccounts) {
      const bal = Math.max(0, runningBalances.get(acc.id) ?? 0)
      if (acc.isLiability) {
        liabilitiesMinor += bal
        byAccountGroup[acc.accountGroup] -= bal
      } else {
        assetsMinor += bal
        byAccountGroup[acc.accountGroup] += bal
      }
      const delta = monthlyDeltas.get(`${acc.id}::${period}`) ?? 0
      runningBalances.set(acc.id, Math.max(0, bal - delta))
    }

    timeline.push({
      period,
      assetsMinor,
      liabilitiesMinor,
      netWorthMinor: assetsMinor - liabilitiesMinor,
      byAccountGroup,
    })
  }
  timeline.reverse()

  const debtInputs: DebtAccountInput[] = filteredAccounts
    .filter((a) => a.isLiability && a.currentBalanceMinor > 0)
    .map((a) => ({
      id: a.id,
      name: a.name,
      balanceMinor: a.currentBalanceMinor,
      interestRateBps: a.interestRateBps,
      minimumPaymentMinor: a.minimumPaymentMinor,
    }))

  let snowball: DebtPayoffSummary
  let avalanche: DebtPayoffSummary
  let interestSavedByAvalancheMinor = 0
  let extraPaymentInterestSavedMinor = 0
  let warning: string | null = null

  try {
    const cmp = compareDebtPayoffStrategies(debtInputs, options, filter.asOfDate)
    snowball = cmp.snowball
    avalanche = cmp.avalanche
    interestSavedByAvalancheMinor = cmp.interestSavedByAvalancheMinor
    extraPaymentInterestSavedMinor = cmp.extraPaymentInterestSavedMinor
  } catch (err) {
    if (err instanceof NonAmortizingDebtError) {
      warning = err.message
      const empty = (strategy: PayoffStrategy): DebtPayoffSummary => ({
        strategy,
        targetOrder: debtInputs.map((d) => d.id),
        debtFreeMonths: 0,
        debtFreeDate: filter.asOfDate.slice(0, 7),
        totalInterestPaidMinor: 0,
        totalPaidMinor: 0,
        baselineInterestMinor: 0,
        interestSavedVsMinimumMinor: 0,
        schedule: [],
      })
      snowball = empty('snowball')
      avalanche = empty('avalanche')
    } else {
      throw err
    }
  }

  const monthlyRecurringNet = snapshot.recurringRules
    .filter((r) => r.isActive)
    .filter((r) => filter.accountIds.length === 0 || filter.accountIds.includes(r.accountId))
    .reduce((sum, r) => {
      if (r.txType === 'income') return sum + Math.abs(Math.trunc(r.amountMinor))
      if (r.txType === 'expense') return sum - Math.abs(Math.trunc(r.amountMinor))
      return sum
    }, 0)

  const [asOfY, asOfM] = parseYmd(filter.asOfDate)
  const horizon = Math.min(120, Math.max(1, Math.trunc(options.projectionMonths)))
  let currentAssets = filteredAccounts
    .filter((a) => !a.isLiability)
    .reduce((sum, a) => sum + Math.max(0, Math.trunc(a.currentBalanceMinor)), 0)
  const initialLiabilities = filteredAccounts
    .filter((a) => a.isLiability)
    .reduce((sum, a) => sum + Math.max(0, Math.trunc(a.currentBalanceMinor)), 0)

  const projectionTimeline: NetWorthPoint[] = []
  for (let step = 1; step <= horizon; step += 1) {
    const [py, pm] = addMonths(asOfY, asOfM, step)
    const period = formatYm(py, pm)
    const liabRemaining =
      avalanche.schedule[step - 1]?.remainingBalanceMinor ??
      (avalanche.debtFreeMonths > 0 && step > avalanche.debtFreeMonths ? 0 : initialLiabilities)
    const debtExtraOutflow = liabRemaining > 0 ? Math.max(0, Math.trunc(options.extraMonthlyMinor)) : 0
    currentAssets = Math.max(0, currentAssets + monthlyRecurringNet - debtExtraOutflow)
    const byAccountGroup = emptyGroupMap()
    byAccountGroup.banking = currentAssets
    byAccountGroup.loan = -liabRemaining
    projectionTimeline.push({
      period,
      assetsMinor: currentAssets,
      liabilitiesMinor: liabRemaining,
      netWorthMinor: currentAssets - liabRemaining,
      byAccountGroup,
    })
  }

  return {
    timeline,
    projectionTimeline,
    snowball,
    avalanche,
    interestSavedByAvalancheMinor,
    extraPaymentInterestSavedMinor,
    warning,
  }
}
