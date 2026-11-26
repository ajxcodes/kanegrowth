use crate::error::AnalyticsError;
use crate::filter::{add_months, format_ym, parse_ymd};
use crate::model::{
    DebtAccountInput, DebtPayoffComparison, DebtPayoffMonthPoint, DebtPayoffOptions,
    DebtPayoffSummary, PayoffStrategy,
};

const MAX_MONTHS: usize = 600;

/// Half-up integer monthly interest accrual: `round(balance * bps / 120_000)`.
pub fn monthly_interest_minor(balance_minor: i64, interest_rate_bps: i64) -> i64 {
    if balance_minor <= 0 || interest_rate_bps <= 0 {
        return 0;
    }
    let numerator = (balance_minor as i128) * (interest_rate_bps as i128);
    ((numerator + 60_000) / 120_000) as i64
}

fn sort_debt_indices(debts: &[DebtAccountInput], strategy: PayoffStrategy) -> Vec<usize> {
    let mut indices: Vec<usize> = (0..debts.len()).collect();
    match strategy {
        PayoffStrategy::Snowball => {
            indices.sort_by(|&a, &b| {
                debts[a]
                    .balance_minor
                    .cmp(&debts[b].balance_minor)
                    .then_with(|| debts[b].interest_rate_bps.cmp(&debts[a].interest_rate_bps))
                    .then_with(|| debts[a].id.cmp(&debts[b].id))
            });
        }
        PayoffStrategy::Avalanche => {
            indices.sort_by(|&a, &b| {
                debts[b]
                    .interest_rate_bps
                    .cmp(&debts[a].interest_rate_bps)
                    .then_with(|| debts[a].balance_minor.cmp(&debts[b].balance_minor))
                    .then_with(|| debts[a].id.cmp(&debts[b].id))
            });
        }
    }
    indices
}

struct SimRun {
    target_order: Vec<String>,
    debt_free_months: usize,
    total_interest_paid_minor: i64,
    total_paid_minor: i64,
    schedule: Vec<DebtPayoffMonthPoint>,
}

fn simulate_single(
    debts: &[DebtAccountInput],
    strategy: PayoffStrategy,
    extra_monthly_minor: i64,
    lump_sum_minor: i64,
    as_of_date: &str,
) -> Result<SimRun, AnalyticsError> {
    let (start_y, start_m, _) = parse_ymd(as_of_date)?;
    let active_debts: Vec<DebtAccountInput> = debts
        .iter()
        .filter(|d| d.balance_minor > 0)
        .cloned()
        .collect();

    if active_debts.is_empty() {
        return Ok(SimRun {
            target_order: vec![],
            debt_free_months: 0,
            total_interest_paid_minor: 0,
            total_paid_minor: 0,
            schedule: vec![],
        });
    }

    let order = sort_debt_indices(&active_debts, strategy);
    let target_order: Vec<String> = order.iter().map(|&i| active_debts[i].id.clone()).collect();
    let mut balances: Vec<i64> = active_debts.iter().map(|d| d.balance_minor).collect();
    let total_min_budget: i64 = active_debts
        .iter()
        .map(|d| d.minimum_payment_minor.max(0))
        .sum();
    let monthly_budget = total_min_budget + extra_monthly_minor.max(0);

    let mut total_paid_minor: i64 = 0;

    // Apply optional one-time lump sum at Month 0 in strategy priority order
    let mut remaining_lump = lump_sum_minor.max(0);
    for &idx in &order {
        if remaining_lump <= 0 {
            break;
        }
        let applied = remaining_lump.min(balances[idx]);
        balances[idx] -= applied;
        remaining_lump -= applied;
        total_paid_minor += applied;
    }

    if balances.iter().all(|&b| b == 0) {
        return Ok(SimRun {
            target_order,
            debt_free_months: 0,
            total_interest_paid_minor: 0,
            total_paid_minor,
            schedule: vec![],
        });
    }

    let mut total_interest_paid_minor: i64 = 0;
    let mut schedule: Vec<DebtPayoffMonthPoint> = Vec::new();
    let mut month: usize = 0;

    while balances.iter().any(|&b| b > 0) {
        month += 1;
        if month > MAX_MONTHS {
            return Err(AnalyticsError::NonAmortizingDebt(format!(
                "payoff exceeds maximum horizon of {MAX_MONTHS} months"
            )));
        }

        let start_total: i64 = balances.iter().sum();
        let mut month_interest: i64 = 0;

        // 1. Accrue interest on every remaining debt
        for (i, debt) in active_debts.iter().enumerate() {
            if balances[i] > 0 {
                let interest = monthly_interest_minor(balances[i], debt.interest_rate_bps);
                balances[i] += interest;
                month_interest += interest;
            }
        }

        let mut remaining_budget = monthly_budget;
        let mut month_paid: i64 = 0;

        // 2. Pay minimum on every active debt
        for (i, debt) in active_debts.iter().enumerate() {
            if balances[i] <= 0 || remaining_budget <= 0 {
                continue;
            }
            let min_pay = debt.minimum_payment_minor.max(0).min(balances[i]).min(remaining_budget);
            balances[i] -= min_pay;
            remaining_budget -= min_pay;
            month_paid += min_pay;
        }

        // 3. Cascade any freed minimums + extra monthly payment into target priority order
        for &idx in &order {
            if remaining_budget <= 0 {
                break;
            }
            if balances[idx] <= 0 {
                continue;
            }
            let extra = remaining_budget.min(balances[idx]);
            balances[idx] -= extra;
            remaining_budget -= extra;
            month_paid += extra;
        }

        let end_total: i64 = balances.iter().sum();
        let principal_reduction = start_total - end_total;
        if end_total > 0 && principal_reduction <= 0 {
            return Err(AnalyticsError::NonAmortizingDebt(
                "monthly payments do not exceed accrued interest".into(),
            ));
        }

        total_interest_paid_minor += month_interest;
        total_paid_minor += month_paid;

        let (py, pm) = add_months(start_y, start_m, month as i32);
        schedule.push(DebtPayoffMonthPoint {
            month_index: month,
            period: format_ym(py, pm),
            remaining_balance_minor: end_total,
            interest_paid_minor: month_interest,
            principal_paid_minor: principal_reduction.max(0),
        });
    }

    Ok(SimRun {
        target_order,
        debt_free_months: month,
        total_interest_paid_minor,
        total_paid_minor,
        schedule,
    })
}

pub fn compare_debt_payoff_strategies(
    debts: &[DebtAccountInput],
    options: &DebtPayoffOptions,
    as_of_date: &str,
) -> Result<DebtPayoffComparison, AnalyticsError> {
    let (start_y, start_m, _) = parse_ymd(as_of_date)?;

    let snowball_base = simulate_single(debts, PayoffStrategy::Snowball, 0, 0, as_of_date)?;
    let avalanche_base = simulate_single(debts, PayoffStrategy::Avalanche, 0, 0, as_of_date)?;

    let snowball_run = simulate_single(
        debts,
        PayoffStrategy::Snowball,
        options.extra_monthly_minor,
        options.lump_sum_minor,
        as_of_date,
    )?;
    let avalanche_run = simulate_single(
        debts,
        PayoffStrategy::Avalanche,
        options.extra_monthly_minor,
        options.lump_sum_minor,
        as_of_date,
    )?;

    let make_date = |months: usize| {
        let (y, m) = add_months(start_y, start_m, months as i32);
        format_ym(y, m)
    };

    let snowball = DebtPayoffSummary {
        strategy: PayoffStrategy::Snowball,
        target_order: snowball_run.target_order,
        debt_free_months: snowball_run.debt_free_months,
        debt_free_date: make_date(snowball_run.debt_free_months),
        total_interest_paid_minor: snowball_run.total_interest_paid_minor,
        total_paid_minor: snowball_run.total_paid_minor,
        baseline_interest_minor: snowball_base.total_interest_paid_minor,
        interest_saved_vs_minimum_minor: (snowball_base.total_interest_paid_minor
            - snowball_run.total_interest_paid_minor)
            .max(0),
        schedule: snowball_run.schedule,
    };

    let avalanche = DebtPayoffSummary {
        strategy: PayoffStrategy::Avalanche,
        target_order: avalanche_run.target_order,
        debt_free_months: avalanche_run.debt_free_months,
        debt_free_date: make_date(avalanche_run.debt_free_months),
        total_interest_paid_minor: avalanche_run.total_interest_paid_minor,
        total_paid_minor: avalanche_run.total_paid_minor,
        baseline_interest_minor: avalanche_base.total_interest_paid_minor,
        interest_saved_vs_minimum_minor: (avalanche_base.total_interest_paid_minor
            - avalanche_run.total_interest_paid_minor)
            .max(0),
        schedule: avalanche_run.schedule,
    };

    let interest_saved_by_avalanche_minor =
        (snowball.total_interest_paid_minor - avalanche.total_interest_paid_minor).max(0);
    let extra_payment_interest_saved_minor = avalanche.interest_saved_vs_minimum_minor;

    Ok(DebtPayoffComparison {
        snowball,
        avalanche,
        interest_saved_by_avalanche_minor,
        extra_payment_interest_saved_minor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_snowball_avalanche_extra_payments_and_rejects_non_amortizing_debt() {
        let debts = vec![
            DebtAccountInput {
                id: "card_a".into(),
                name: "Card A".into(),
                balance_minor: 200_000,
                interest_rate_bps: 1200,
                minimum_payment_minor: 5_000,
            },
            DebtAccountInput {
                id: "card_b".into(),
                name: "Card B".into(),
                balance_minor: 400_000,
                interest_rate_bps: 2400,
                minimum_payment_minor: 10_000,
            },
        ];

        let base_opts = DebtPayoffOptions {
            extra_monthly_minor: 0,
            lump_sum_minor: 0,
            projection_months: 24,
        };
        let base_cmp = compare_debt_payoff_strategies(&debts, &base_opts, "2026-11-25").unwrap();
        assert_eq!(base_cmp.snowball.target_order, vec!["card_a", "card_b"]);
        assert_eq!(base_cmp.avalanche.target_order, vec!["card_b", "card_a"]);
        assert!(
            base_cmp.avalanche.total_interest_paid_minor
                <= base_cmp.snowball.total_interest_paid_minor
        );

        let extra_opts = DebtPayoffOptions {
            extra_monthly_minor: 10_000,
            lump_sum_minor: 0,
            projection_months: 24,
        };
        let extra_cmp = compare_debt_payoff_strategies(&debts, &extra_opts, "2026-11-25").unwrap();
        assert_eq!(extra_cmp.snowball.target_order, vec!["card_a", "card_b"]);
        assert_eq!(extra_cmp.avalanche.target_order, vec!["card_b", "card_a"]);
        assert!(
            extra_cmp.avalanche.total_interest_paid_minor
                < extra_cmp.snowball.total_interest_paid_minor
        );
        assert!(extra_cmp.interest_saved_by_avalanche_minor > 0);
        assert!(extra_cmp.avalanche.debt_free_months < base_cmp.avalanche.debt_free_months);
        assert!(extra_cmp.snowball.debt_free_months < base_cmp.snowball.debt_free_months);
        assert!(extra_cmp.extra_payment_interest_saved_minor > 0);

        // Non-amortizing debt: 24% APR on $10,000 ($200/mo interest) with only $50/mo min payment
        let bad_debts = vec![DebtAccountInput {
            id: "bad_card".into(),
            name: "Bad Card".into(),
            balance_minor: 1_000_000,
            interest_rate_bps: 2400,
            minimum_payment_minor: 5_000,
        }];
        let err = compare_debt_payoff_strategies(&bad_debts, &base_opts, "2026-11-25").unwrap_err();
        assert!(matches!(err, AnalyticsError::NonAmortizingDebt(_)));
    }
}
