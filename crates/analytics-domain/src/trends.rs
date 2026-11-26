use crate::error::AnalyticsError;
use crate::filter::{add_months, format_ym, month_sequence, parse_ymd, AnalyticsFilter, FlowBasis};
use crate::model::{
    CategoryRecord, CategoryTrendPoint, CategoryTrendSummary, CategoryTrendsReport, EnvelopeType,
    LedgerSnapshot, TxType,
};
use std::collections::BTreeMap;

fn pct_delta(delta: i64, base: i64) -> Option<f64> {
    if base <= 0 {
        return None;
    }
    Some(((delta as f64) * 10000.0 / (base as f64)).round() / 100.0)
}

pub fn compute_category_trends(
    snapshot: &LedgerSnapshot,
    filter: &AnalyticsFilter,
    rolling_window: usize,
) -> Result<CategoryTrendsReport, AnalyticsError> {
    let window = rolling_window.max(1);
    let (start_date, end_date) = filter.resolved_date_bounds()?;
    let start_ym = start_date.get(0..7).unwrap_or("1970-01").to_string();
    let end_ym = end_date.get(0..7).unwrap_or("1970-01").to_string();
    let periods = month_sequence(&start_ym, &end_ym)?;

    let cat_map: BTreeMap<&str, &CategoryRecord> = snapshot
        .categories
        .iter()
        .map(|c| (c.id.as_str(), c))
        .collect();

    // Aggregate ALL matching transactions across full history (ignoring date bounds)
    // so trailing rolling averages and prior-year YoY values are accurate even on `this_month`.
    let mut totals: BTreeMap<(String, String), (i64, usize)> = BTreeMap::new();
    let mut active_categories: BTreeMap<String, &CategoryRecord> = BTreeMap::new();

    for tx in &snapshot.transactions {
        if !filter.matches_dimensions(tx, true) {
            continue;
        }
        let Some(cat) = cat_map.get(tx.category_id.as_str()).copied() else {
            continue;
        };
        if matches!(cat.envelope_type, EnvelopeType::Income | EnvelopeType::Transfer) {
            continue;
        }
        let ym = match tx.date.get(0..7) {
            Some(s) if s.len() == 7 => s.to_string(),
            _ => continue,
        };
        let amt = tx.amount_minor.abs();
        let signed = match tx.tx_type {
            TxType::Expense => amt,
            TxType::Income if filter.flow_basis == FlowBasis::Net => -amt,
            _ => 0,
        };
        if signed == 0 {
            continue;
        }
        let entry = totals.entry((cat.id.clone(), ym)).or_insert((0, 0));
        entry.0 += signed;
        entry.1 += 1;
        active_categories.insert(cat.id.clone(), cat);
    }

    // Ensure filtered categories appear even if 0 in selected range
    for cid in &filter.category_ids {
        if let Some(cat) = cat_map.get(cid.as_str()).copied() {
            if !matches!(cat.envelope_type, EnvelopeType::Income | EnvelopeType::Transfer) {
                active_categories.insert(cat.id.clone(), cat);
            }
        }
    }

    let mut series: Vec<CategoryTrendPoint> = Vec::new();
    let mut summaries: Vec<CategoryTrendSummary> = Vec::new();

    for (cat_id, cat) in active_categories {
        let mut total_in_range: i64 = 0;
        let mut latest_amount: i64 = 0;
        let mut anomaly_count: usize = 0;
        let mut overage_count: usize = 0;

        for period in &periods {
            let (py, pm, _) = parse_ymd(&format!("{period}-01"))?;
            let (amount_raw, tx_count) = totals
                .get(&(cat_id.clone(), period.clone()))
                .copied()
                .unwrap_or((0, 0));
            let amount_minor = amount_raw.max(0);
            total_in_range += amount_minor;
            latest_amount = amount_minor;

            // Trailing N-month rolling average (prior N months excluding current month)
            let mut rolling_sum: i64 = 0;
            let mut rolling_count: i64 = 0;
            for offset in 1..=(window as i32) {
                let (ry, rm) = add_months(py, pm, -offset);
                let r_ym = format_ym(ry, rm);
                if let Some((val, _)) = totals.get(&(cat_id.clone(), r_ym)) {
                    rolling_sum += (*val).max(0);
                    rolling_count += 1;
                }
            }
            let rolling_avg_minor = if rolling_count > 0 {
                (rolling_sum + rolling_count / 2) / rolling_count
            } else {
                0
            };

            // MoM delta against previous month
            let (prev_y, prev_m) = add_months(py, pm, -1);
            let prev_ym = format_ym(prev_y, prev_m);
            let prev_opt = totals
                .get(&(cat_id.clone(), prev_ym))
                .map(|(v, _)| (*v).max(0));
            let (mom_delta_minor, mom_delta_pct) = match prev_opt {
                Some(prev) => {
                    let delta = amount_minor - prev;
                    (Some(delta), pct_delta(delta, prev))
                }
                None => (None, None),
            };

            // YoY delta against same month last year
            let prior_year_ym = format_ym(py - 1, pm);
            let prior_year_amount_minor = totals
                .get(&(cat_id.clone(), prior_year_ym))
                .map(|(v, _)| (*v).max(0));
            let (yoy_delta_minor, yoy_delta_pct) = match prior_year_amount_minor {
                Some(prior) => {
                    let delta = amount_minor - prior;
                    (Some(delta), pct_delta(delta, prior))
                }
                None => (None, None),
            };

            let target = cat.monthly_target_minor.max(0);
            let overage_minor = if target > 0 && amount_minor > target {
                amount_minor - target
            } else {
                0
            };
            let is_over_threshold = target > 0 && amount_minor > target;
            let is_anomaly = is_over_threshold
                || (rolling_avg_minor > 0 && amount_minor * 100 > rolling_avg_minor * 125);

            if is_over_threshold {
                overage_count += 1;
            }
            if is_anomaly {
                anomaly_count += 1;
            }

            series.push(CategoryTrendPoint {
                period: period.clone(),
                category_id: cat_id.clone(),
                category_name: cat.name.clone(),
                amount_minor,
                rolling_avg_minor,
                mom_delta_minor,
                mom_delta_pct,
                prior_year_amount_minor,
                yoy_delta_minor,
                yoy_delta_pct,
                monthly_target_minor: target,
                overage_minor,
                is_over_threshold,
                is_anomaly,
                tx_count,
            });
        }

        summaries.push(CategoryTrendSummary {
            category_id: cat_id,
            category_name: cat.name.clone(),
            total_amount_minor: total_in_range,
            latest_amount_minor: latest_amount,
            monthly_target_minor: cat.monthly_target_minor.max(0),
            anomaly_count,
            overage_count,
        });
    }

    summaries.sort_by(|a, b| {
        b.total_amount_minor
            .cmp(&a.total_amount_minor)
            .then_with(|| a.category_name.cmp(&b.category_name))
    });

    Ok(CategoryTrendsReport {
        periods,
        series,
        summaries,
        rolling_window: window,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::DateRangePreset;
    use crate::model::{AccountGroup, AccountRecord, TransactionRecord};

    #[test]
    fn category_trends_computes_mom_rolling_average_yoy_and_anomaly_overage() {
        let months = [
            ("2025-10-15", 38_000),
            ("2025-11-15", 39_000),
            ("2025-12-15", 43_000),
            ("2026-01-15", 37_000),
            ("2026-02-15", 39_000),
            ("2026-03-15", 40_000),
            ("2026-04-15", 38_000),
            ("2026-05-15", 41_000),
            ("2026-06-15", 40_000),
            ("2026-07-15", 39_000),
            ("2026-08-15", 40_000),
            ("2026-09-15", 41_000),
            ("2026-10-15", 42_000),
            ("2026-11-15", 52_000),
        ];

        let txs: Vec<TransactionRecord> = months
            .iter()
            .enumerate()
            .map(|(i, (date, amt))| TransactionRecord {
                id: format!("tx_{i}"),
                account_id: "acc_1".into(),
                category_id: "cat_dining".into(),
                tx_type: TxType::Expense,
                status: "posted".into(),
                amount_minor: *amt,
                date: (*date).into(),
                description: "Dining".into(),
                member_id: None,
                is_shared: true,
                transfer_pair_id: None,
                has_split_children: false,
                split_transaction_id: None,
                tag_ids: vec![],
            })
            .collect();

        let snapshot = LedgerSnapshot {
            accounts: vec![AccountRecord {
                id: "acc_1".into(),
                name: "Card".into(),
                account_type: "credit".into(),
                account_group: AccountGroup::Credit,
                currency: "USD".into(),
                current_balance_minor: 50_000,
                is_liability: true,
                interest_rate_bps: 1800,
                minimum_payment_minor: 2500,
            }],
            categories: vec![CategoryRecord {
                id: "cat_dining".into(),
                name: "Dining Out".into(),
                envelope_type: EnvelopeType::Expense,
                monthly_target_minor: 40_000,
            }],
            tags: vec![],
            members: vec![],
            recurring_rules: vec![],
            transactions: txs,
        };

        let mut filter = AnalyticsFilter::default_for("2026-11-25");
        filter.date_range_preset = DateRangePreset::Last12Months;
        let report = compute_category_trends(&snapshot, &filter, 3).unwrap();

        let nov = report
            .series
            .iter()
            .find(|p| p.period == "2026-11" && p.category_id == "cat_dining")
            .unwrap();
        assert_eq!(nov.amount_minor, 52_000);
        assert_eq!(nov.rolling_avg_minor, 41_000);
        assert_eq!(nov.prior_year_amount_minor, Some(39_000));
        assert_eq!(nov.yoy_delta_minor, Some(13_000));
        assert_eq!(nov.overage_minor, 12_000);
        assert!(nov.is_over_threshold);
        assert!(nov.is_anomaly);
    }
}
