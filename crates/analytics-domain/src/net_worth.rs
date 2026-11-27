use crate::debt_payoff::compare_debt_payoff_strategies;
use crate::error::AnalyticsError;
use crate::filter::{add_months, format_ym, month_sequence, parse_ymd, AnalyticsFilter};
use crate::model::{
    AccountGroup, AccountRecord, DebtAccountInput, DebtPayoffOptions, DebtPayoffSummary,
    LedgerSnapshot, NetWorthAndDebtReport, NetWorthPoint, PayoffStrategy, TxType,
};
use std::collections::BTreeMap;

fn empty_group_map() -> BTreeMap<String, i64> {
    let mut map = BTreeMap::new();
    for g in [
        AccountGroup::Banking,
        AccountGroup::Investment,
        AccountGroup::Cash,
        AccountGroup::Credit,
        AccountGroup::Loan,
    ] {
        map.insert(g.as_str().to_string(), 0);
    }
    map
}

pub fn compute_net_worth_and_debt(
    snapshot: &LedgerSnapshot,
    filter: &AnalyticsFilter,
    options: &DebtPayoffOptions,
) -> Result<NetWorthAndDebtReport, AnalyticsError> {
    let (start_date, end_date) = filter.resolved_date_bounds()?;
    let start_ym = start_date.get(0..7).unwrap_or("1970-01").to_string();
    let end_ym = end_date.get(0..7).unwrap_or("1970-01").to_string();
    let periods = month_sequence(&start_ym, &end_ym)?;

    let filtered_accounts: Vec<&AccountRecord> = snapshot
        .accounts
        .iter()
        .filter(|a| {
            filter.account_ids.is_empty() || filter.account_ids.iter().any(|id| id == &a.id)
        })
        .collect();

    // Map per-account net monthly delta for transactions in each month
    // For assets: income increases balance, expense decreases balance
    // For liabilities: expense increases debt balance, income/payment decreases debt balance
    let mut monthly_deltas: BTreeMap<(String, String), i64> = BTreeMap::new();
    for tx in &snapshot.transactions {
        if !filter.matches_dimensions(tx, true) {
            continue;
        }
        let Some(ym) = tx.date.get(0..7) else {
            continue;
        };
        let amt = tx.amount_minor.abs();
        let is_liab = filtered_accounts
            .iter()
            .find(|a| a.id == tx.account_id)
            .map(|a| a.is_liability)
            .unwrap_or(false);

        let delta = match (tx.tx_type, is_liab) {
            (TxType::Income, false) => amt,
            (TxType::Expense, false) => -amt,
            (TxType::Expense, true) => amt,
            (TxType::Income, true) => -amt,
            (TxType::Transfer, _) => 0,
        };
        if delta != 0 {
            *monthly_deltas
                .entry((tx.account_id.clone(), ym.to_string()))
                .or_insert(0) += delta;
        }
    }

    // Reconstruct historical month-end balances backwards from current_balance_minor
    let mut running_balances: BTreeMap<String, i64> = filtered_accounts
        .iter()
        .map(|a| (a.id.clone(), a.current_balance_minor))
        .collect();

    let mut timeline: Vec<NetWorthPoint> = Vec::with_capacity(periods.len());
    for period in periods.iter().rev() {
        let mut assets_minor: i64 = 0;
        let mut liabilities_minor: i64 = 0;
        let mut by_group = empty_group_map();

        for acc in &filtered_accounts {
            let bal = running_balances.get(&acc.id).copied().unwrap_or(0).max(0);
            if acc.is_liability {
                liabilities_minor += bal;
                *by_group
                    .entry(acc.account_group.as_str().to_string())
                    .or_insert(0) -= bal;
            } else {
                assets_minor += bal;
                *by_group
                    .entry(acc.account_group.as_str().to_string())
                    .or_insert(0) += bal;
            }

            // Step backwards to prior month end
            let delta = monthly_deltas
                .get(&(acc.id.clone(), period.clone()))
                .copied()
                .unwrap_or(0);
            let prior = (bal - delta).max(0);
            running_balances.insert(acc.id.clone(), prior);
        }

        timeline.push(NetWorthPoint {
            period: period.clone(),
            assets_minor,
            liabilities_minor,
            net_worth_minor: assets_minor - liabilities_minor,
            by_account_group: by_group,
        });
    }
    timeline.reverse();

    // Debt payoff comparison on liability accounts
    let debt_inputs: Vec<DebtAccountInput> = filtered_accounts
        .iter()
        .filter(|a| a.is_liability && a.current_balance_minor > 0)
        .map(|a| DebtAccountInput {
            id: a.id.clone(),
            name: a.name.clone(),
            balance_minor: a.current_balance_minor,
            interest_rate_bps: a.interest_rate_bps,
            minimum_payment_minor: a.minimum_payment_minor,
        })
        .collect();

    let (
        snowball,
        avalanche,
        interest_saved_by_avalanche_minor,
        extra_payment_interest_saved_minor,
        warning,
    ) = match compare_debt_payoff_strategies(&debt_inputs, options, &filter.as_of_date) {
        Ok(cmp) => (
            cmp.snowball,
            cmp.avalanche,
            cmp.interest_saved_by_avalanche_minor,
            cmp.extra_payment_interest_saved_minor,
            None,
        ),
        Err(AnalyticsError::NonAmortizingDebt(msg)) => {
            let empty_summary = |strategy| DebtPayoffSummary {
                strategy,
                target_order: debt_inputs.iter().map(|d| d.id.clone()).collect(),
                debt_free_months: 0,
                debt_free_date: filter.as_of_date.get(0..7).unwrap_or("2026-01").to_string(),
                total_interest_paid_minor: 0,
                total_paid_minor: 0,
                baseline_interest_minor: 0,
                interest_saved_vs_minimum_minor: 0,
                schedule: vec![],
            };
            (
                empty_summary(PayoffStrategy::Snowball),
                empty_summary(PayoffStrategy::Avalanche),
                0,
                0,
                Some(msg),
            )
        }
        Err(e) => return Err(e),
    };

    // Forward-looking net worth projection using active recurring rules + avalanche debt schedule
    let monthly_recurring_net: i64 = snapshot
        .recurring_rules
        .iter()
        .filter(|r| r.is_active)
        .filter(|r| {
            filter.account_ids.is_empty() || filter.account_ids.iter().any(|id| id == &r.account_id)
        })
        .map(|r| match r.tx_type {
            TxType::Income => r.amount_minor.abs(),
            TxType::Expense => -r.amount_minor.abs(),
            TxType::Transfer => 0,
        })
        .sum();

    let (as_of_y, as_of_m, _) = parse_ymd(&filter.as_of_date)?;
    let horizon = options.projection_months.clamp(1, 120);
    let mut current_assets: i64 = filtered_accounts
        .iter()
        .filter(|a| !a.is_liability)
        .map(|a| a.current_balance_minor.max(0))
        .sum();
    let initial_liabilities: i64 = filtered_accounts
        .iter()
        .filter(|a| a.is_liability)
        .map(|a| a.current_balance_minor.max(0))
        .sum();

    let mut projection_timeline: Vec<NetWorthPoint> = Vec::with_capacity(horizon);
    for step in 1..=horizon {
        let (py, pm) = add_months(as_of_y, as_of_m, step as i32);
        let period = format_ym(py, pm);
        let liab_remaining = avalanche
            .schedule
            .get(step - 1)
            .map(|p| p.remaining_balance_minor)
            .unwrap_or_else(|| {
                if avalanche.debt_free_months > 0 && step > avalanche.debt_free_months {
                    0
                } else {
                    initial_liabilities
                }
            });
        // Net asset growth accounts for recurring net cash flow minus extra debt payments while debt remains
        let debt_extra_outflow = if liab_remaining > 0 {
            options.extra_monthly_minor.max(0)
        } else {
            0
        };
        current_assets = (current_assets + monthly_recurring_net - debt_extra_outflow).max(0);
        let mut by_group = empty_group_map();
        by_group.insert("banking".into(), current_assets);
        by_group.insert("loan".into(), -liab_remaining);
        projection_timeline.push(NetWorthPoint {
            period,
            assets_minor: current_assets,
            liabilities_minor: liab_remaining,
            net_worth_minor: current_assets - liab_remaining,
            by_account_group: by_group,
        });
    }

    Ok(NetWorthAndDebtReport {
        timeline,
        projection_timeline,
        snowball,
        avalanche,
        interest_saved_by_avalanche_minor,
        extra_payment_interest_saved_minor,
        warning,
    })
}
