use crate::error::AnalyticsError;
use crate::filter::{AnalyticsFilter, FlowBasis};
use crate::model::{
    CashFlowSankeyGraph, CategoryRecord, EnvelopeType, LedgerSnapshot, SankeyLink, SankeyNode,
    SankeyNodeKind, TxType,
};
use std::collections::BTreeMap;

fn pct(part: i64, total: i64) -> f64 {
    if total <= 0 {
        return 0.0;
    }
    ((part as f64) * 10000.0 / (total as f64)).round() / 100.0
}

pub fn compute_cash_flow_sankey(
    snapshot: &LedgerSnapshot,
    filter: &AnalyticsFilter,
) -> Result<CashFlowSankeyGraph, AnalyticsError> {
    let (start_date, end_date) = filter.resolved_date_bounds()?;

    let cat_map: BTreeMap<&str, &CategoryRecord> = snapshot
        .categories
        .iter()
        .map(|c| (c.id.as_str(), c))
        .collect();

    // Track income sources (by category_id) and outflows (by category_id)
    let mut income_by_cat: BTreeMap<String, (String, i64, usize)> = BTreeMap::new();
    let mut outflow_by_cat: BTreeMap<String, (String, SankeyNodeKind, i64, usize)> =
        BTreeMap::new();
    let mut transfer_total_minor: i64 = 0;
    let mut transfer_tx_count: usize = 0;
    let mut excluded_transfer_minor: i64 = 0;

    for tx in &snapshot.transactions {
        if !filter.matches_transaction(tx, &start_date, &end_date, false) {
            continue;
        }
        let amount = tx.amount_minor.abs();
        if amount == 0 {
            continue;
        }

        if AnalyticsFilter::is_transfer(tx) {
            if filter.include_transfers {
                transfer_total_minor += amount;
                transfer_tx_count += 1;
            } else {
                excluded_transfer_minor += amount;
            }
            continue;
        }

        let cat = cat_map.get(tx.category_id.as_str()).copied();
        let cat_name = cat
            .map(|c| c.name.clone())
            .unwrap_or_else(|| "Uncategorized".to_string());
        let env_type = cat.map(|c| c.envelope_type).unwrap_or(match tx.tx_type {
            TxType::Income => EnvelopeType::Income,
            TxType::Transfer => EnvelopeType::Transfer,
            TxType::Expense => EnvelopeType::Expense,
        });

        match tx.tx_type {
            TxType::Income => {
                // In Net mode, an income/refund posted to an expense/sinking/savings category offsets that category
                if filter.flow_basis == FlowBasis::Net && env_type != EnvelopeType::Income {
                    let kind = match env_type {
                        EnvelopeType::SinkingFund => SankeyNodeKind::SinkingFund,
                        EnvelopeType::Savings => SankeyNodeKind::Savings,
                        _ => SankeyNodeKind::Expense,
                    };
                    let entry = outflow_by_cat
                        .entry(tx.category_id.clone())
                        .or_insert((cat_name, kind, 0, 0));
                    entry.2 -= amount;
                    entry.3 += 1;
                } else {
                    let label = if env_type == EnvelopeType::Income {
                        cat_name
                    } else {
                        format!("{cat_name} (Refunds)")
                    };
                    let entry = income_by_cat
                        .entry(tx.category_id.clone())
                        .or_insert((label, 0, 0));
                    entry.1 += amount;
                    entry.2 += 1;
                }
            }
            TxType::Expense => {
                let kind = match env_type {
                    EnvelopeType::SinkingFund => SankeyNodeKind::SinkingFund,
                    EnvelopeType::Savings => SankeyNodeKind::Savings,
                    _ => SankeyNodeKind::Expense,
                };
                let entry = outflow_by_cat
                    .entry(tx.category_id.clone())
                    .or_insert((cat_name, kind, 0, 0));
                entry.2 += amount;
                entry.3 += 1;
            }
            TxType::Transfer => {}
        }
    }

    // Reconcile any net-negative outflow categories into income credits in Net mode
    let mut cleaned_outflows: Vec<(String, String, SankeyNodeKind, i64, usize)> = Vec::new();
    for (cat_id, (label, kind, amt, count)) in outflow_by_cat {
        if amt > 0 {
            cleaned_outflows.push((cat_id, label, kind, amt, count));
        } else if amt < 0 {
            let entry = income_by_cat.entry(format!("{cat_id}__credit")).or_insert((
                format!("{label} (Net Credit)"),
                0,
                0,
            ));
            entry.1 += -amt;
            entry.2 += count;
        }
    }

    let mut income_entries: Vec<(String, String, i64, usize)> = income_by_cat
        .into_iter()
        .filter(|(_, (_, amt, _))| *amt > 0)
        .map(|(id, (label, amt, count))| (id, label, amt, count))
        .collect();
    income_entries.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));

    cleaned_outflows.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| a.1.cmp(&b.1)));

    let total_inflow_minor: i64 = income_entries.iter().map(|e| e.2).sum();
    let base_outflow_minor: i64 = cleaned_outflows.iter().map(|e| e.3).sum();
    let total_outflow_minor = base_outflow_minor + transfer_total_minor;
    let net_savings_minor = total_inflow_minor - total_outflow_minor;

    let pool_minor = total_inflow_minor.max(total_outflow_minor);

    let mut tier0_nodes: Vec<SankeyNode> = Vec::new();
    let mut tier2_nodes: Vec<SankeyNode> = Vec::new();
    let mut links: Vec<SankeyLink> = Vec::new();

    for (cat_id, label, amt, count) in &income_entries {
        let node_id = format!("src_{cat_id}");
        let share = pct(*amt, pool_minor);
        tier0_nodes.push(SankeyNode {
            id: node_id.clone(),
            label: label.clone(),
            tier: 0,
            kind: SankeyNodeKind::Income,
            amount_minor: *amt,
            share_pct: share,
            tx_count: *count,
            category_id: Some(cat_id.clone()),
            x: 0.0,
            y: 0.0,
            width: 18.0,
            height: 0.0,
        });
        links.push(SankeyLink {
            id: format!("link_{node_id}_pool"),
            source_id: node_id,
            target_id: "pool_household".to_string(),
            amount_minor: *amt,
            share_pct: share,
            tx_count: *count,
            category_id: Some(cat_id.clone()),
            flow_kind: SankeyNodeKind::Income,
        });
    }

    if total_outflow_minor > total_inflow_minor {
        let deficit = total_outflow_minor - total_inflow_minor;
        let share = pct(deficit, pool_minor);
        tier0_nodes.push(SankeyNode {
            id: "src_deficit".to_string(),
            label: "Deficit / Balance Draw".to_string(),
            tier: 0,
            kind: SankeyNodeKind::Deficit,
            amount_minor: deficit,
            share_pct: share,
            tx_count: 0,
            category_id: None,
            x: 0.0,
            y: 0.0,
            width: 18.0,
            height: 0.0,
        });
        links.push(SankeyLink {
            id: "link_src_deficit_pool".to_string(),
            source_id: "src_deficit".to_string(),
            target_id: "pool_household".to_string(),
            amount_minor: deficit,
            share_pct: share,
            tx_count: 0,
            category_id: None,
            flow_kind: SankeyNodeKind::Deficit,
        });
    }

    for (cat_id, label, kind, amt, count) in &cleaned_outflows {
        let node_id = format!("dst_{cat_id}");
        let share = pct(*amt, pool_minor);
        tier2_nodes.push(SankeyNode {
            id: node_id.clone(),
            label: label.clone(),
            tier: 2,
            kind: *kind,
            amount_minor: *amt,
            share_pct: share,
            tx_count: *count,
            category_id: Some(cat_id.clone()),
            x: 0.0,
            y: 0.0,
            width: 18.0,
            height: 0.0,
        });
        links.push(SankeyLink {
            id: format!("link_pool_{node_id}"),
            source_id: "pool_household".to_string(),
            target_id: node_id,
            amount_minor: *amt,
            share_pct: share,
            tx_count: *count,
            category_id: Some(cat_id.clone()),
            flow_kind: *kind,
        });
    }

    if filter.include_transfers && transfer_total_minor > 0 {
        let share = pct(transfer_total_minor, pool_minor);
        tier2_nodes.push(SankeyNode {
            id: "dst_internal_transfers".to_string(),
            label: "Internal Transfers".to_string(),
            tier: 2,
            kind: SankeyNodeKind::Transfer,
            amount_minor: transfer_total_minor,
            share_pct: share,
            tx_count: transfer_tx_count,
            category_id: None,
            x: 0.0,
            y: 0.0,
            width: 18.0,
            height: 0.0,
        });
        links.push(SankeyLink {
            id: "link_pool_dst_internal_transfers".to_string(),
            source_id: "pool_household".to_string(),
            target_id: "dst_internal_transfers".to_string(),
            amount_minor: transfer_total_minor,
            share_pct: share,
            tx_count: transfer_tx_count,
            category_id: None,
            flow_kind: SankeyNodeKind::Transfer,
        });
    }

    if total_inflow_minor > total_outflow_minor {
        let surplus = total_inflow_minor - total_outflow_minor;
        let share = pct(surplus, pool_minor);
        tier2_nodes.push(SankeyNode {
            id: "dst_surplus".to_string(),
            label: "Unallocated Surplus".to_string(),
            tier: 2,
            kind: SankeyNodeKind::Surplus,
            amount_minor: surplus,
            share_pct: share,
            tx_count: 0,
            category_id: None,
            x: 0.0,
            y: 0.0,
            width: 18.0,
            height: 0.0,
        });
        links.push(SankeyLink {
            id: "link_pool_dst_surplus".to_string(),
            source_id: "pool_household".to_string(),
            target_id: "dst_surplus".to_string(),
            amount_minor: surplus,
            share_pct: share,
            tx_count: 0,
            category_id: None,
            flow_kind: SankeyNodeKind::Surplus,
        });
    }

    // Deterministic SVG layout coordinates (virtual canvas 760 x 360)
    let canvas_height = 320.0_f64;
    let gap = 12.0_f64;
    layout_column(&mut tier0_nodes, 24.0, canvas_height, gap, pool_minor);
    layout_column(&mut tier2_nodes, 718.0, canvas_height, gap, pool_minor);

    let mut nodes = Vec::with_capacity(tier0_nodes.len() + tier2_nodes.len() + 1);
    nodes.extend(tier0_nodes);
    if pool_minor > 0 {
        nodes.push(SankeyNode {
            id: "pool_household".to_string(),
            label: "Household Cash Pool".to_string(),
            tier: 1,
            kind: SankeyNodeKind::Pool,
            amount_minor: pool_minor,
            share_pct: 100.0,
            tx_count: 0,
            category_id: None,
            x: 371.0,
            y: 20.0,
            width: 18.0,
            height: canvas_height,
        });
    }
    nodes.extend(tier2_nodes);

    Ok(CashFlowSankeyGraph {
        nodes,
        links,
        total_inflow_minor,
        total_outflow_minor,
        net_savings_minor,
        excluded_transfer_minor,
    })
}

fn layout_column(
    nodes: &mut [SankeyNode],
    x: f64,
    available_height: f64,
    gap: f64,
    pool_minor: i64,
) {
    if nodes.is_empty() || pool_minor <= 0 {
        return;
    }
    let total_gaps = gap * (nodes.len().saturating_sub(1) as f64);
    let usable_h = (available_height - total_gaps).max(40.0);
    let mut cursor_y = 20.0;
    for node in nodes.iter_mut() {
        let ratio = (node.amount_minor as f64) / (pool_minor as f64);
        let h = (usable_h * ratio).max(12.0);
        node.x = x;
        node.y = cursor_y;
        node.height = h;
        cursor_y += h + gap;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::DateRangePreset;
    use crate::model::{AccountGroup, AccountRecord, TransactionRecord};

    #[test]
    fn cash_flow_sankey_excludes_transfers_balances_deficit_and_toggles_gross_net() {
        let snapshot = LedgerSnapshot {
            accounts: vec![AccountRecord {
                id: "acc_1".into(),
                name: "Checking".into(),
                account_type: "checking".into(),
                account_group: AccountGroup::Banking,
                currency: "USD".into(),
                current_balance_minor: 500_000,
                is_liability: false,
                interest_rate_bps: 0,
                minimum_payment_minor: 0,
            }],
            categories: vec![
                CategoryRecord {
                    id: "cat_inc".into(),
                    name: "Salary".into(),
                    envelope_type: EnvelopeType::Income,
                    monthly_target_minor: 0,
                },
                CategoryRecord {
                    id: "cat_exp".into(),
                    name: "Housing".into(),
                    envelope_type: EnvelopeType::Expense,
                    monthly_target_minor: 300_000,
                },
                CategoryRecord {
                    id: "cat_sink".into(),
                    name: "Home Sinking".into(),
                    envelope_type: EnvelopeType::SinkingFund,
                    monthly_target_minor: 150_000,
                },
                CategoryRecord {
                    id: "cat_xfer".into(),
                    name: "Transfer".into(),
                    envelope_type: EnvelopeType::Transfer,
                    monthly_target_minor: 0,
                },
            ],
            tags: vec![],
            members: vec![],
            recurring_rules: vec![],
            transactions: vec![
                TransactionRecord {
                    id: "t1".into(),
                    account_id: "acc_1".into(),
                    category_id: "cat_inc".into(),
                    tx_type: TxType::Income,
                    status: "posted".into(),
                    amount_minor: 500_000,
                    date: "2026-11-01".into(),
                    description: "Salary".into(),
                    member_id: None,
                    is_shared: true,
                    transfer_pair_id: None,
                    has_split_children: false,
                    split_transaction_id: None,
                    tag_ids: vec![],
                },
                TransactionRecord {
                    id: "t2".into(),
                    account_id: "acc_1".into(),
                    category_id: "cat_xfer".into(),
                    tx_type: TxType::Transfer,
                    status: "posted".into(),
                    amount_minor: 100_000,
                    date: "2026-11-02".into(),
                    description: "Internal Transfer".into(),
                    member_id: None,
                    is_shared: true,
                    transfer_pair_id: Some("pair_1".into()),
                    has_split_children: false,
                    split_transaction_id: None,
                    tag_ids: vec![],
                },
                TransactionRecord {
                    id: "t3".into(),
                    account_id: "acc_1".into(),
                    category_id: "cat_exp".into(),
                    tx_type: TxType::Expense,
                    status: "posted".into(),
                    amount_minor: 300_000,
                    date: "2026-11-03".into(),
                    description: "Rent".into(),
                    member_id: None,
                    is_shared: true,
                    transfer_pair_id: None,
                    has_split_children: false,
                    split_transaction_id: None,
                    tag_ids: vec![],
                },
                TransactionRecord {
                    id: "t4".into(),
                    account_id: "acc_1".into(),
                    category_id: "cat_sink".into(),
                    tx_type: TxType::Expense,
                    status: "posted".into(),
                    amount_minor: 150_000,
                    date: "2026-11-04".into(),
                    description: "Sinking Fund".into(),
                    member_id: None,
                    is_shared: true,
                    transfer_pair_id: None,
                    has_split_children: false,
                    split_transaction_id: None,
                    tag_ids: vec![],
                },
            ],
        };

        // 1. Default net mode (transfers excluded)
        let mut filter = AnalyticsFilter::default_for("2026-11-25");
        let graph = compute_cash_flow_sankey(&snapshot, &filter).unwrap();
        assert_eq!(graph.total_inflow_minor, 500_000);
        assert_eq!(graph.total_outflow_minor, 450_000);
        assert_eq!(graph.net_savings_minor, 50_000);
        assert_eq!(graph.excluded_transfer_minor, 100_000);
        let tier2_sum: i64 = graph
            .nodes
            .iter()
            .filter(|n| n.tier == 2)
            .map(|n| n.amount_minor)
            .sum();
        assert_eq!(tier2_sum, 500_000);
        let surplus = graph
            .nodes
            .iter()
            .find(|n| n.kind == SankeyNodeKind::Surplus)
            .unwrap();
        assert_eq!(surplus.amount_minor, 50_000);

        // 2. include_transfers = true adds 100_000 transfer link
        filter.include_transfers = true;
        let with_xfer = compute_cash_flow_sankey(&snapshot, &filter).unwrap();
        let xfer_link = with_xfer
            .links
            .iter()
            .find(|l| l.flow_kind == SankeyNodeKind::Transfer)
            .unwrap();
        assert_eq!(xfer_link.amount_minor, 100_000);
        assert_eq!(with_xfer.excluded_transfer_minor, 0);

        // 3. Zero-income month emits explicit deficit source node summing to outflows with zero NaN
        let mut deficit_snapshot = snapshot.clone();
        deficit_snapshot
            .transactions
            .retain(|t| t.tx_type == TxType::Expense);
        let mut deficit_filter = AnalyticsFilter::default_for("2026-11-25");
        deficit_filter.date_range_preset = DateRangePreset::ThisMonth;
        let deficit_graph = compute_cash_flow_sankey(&deficit_snapshot, &deficit_filter).unwrap();
        let deficit_node = deficit_graph
            .nodes
            .iter()
            .find(|n| n.kind == SankeyNodeKind::Deficit)
            .unwrap();
        assert_eq!(deficit_node.amount_minor, 450_000);
        assert!(!deficit_node.share_pct.is_nan());
        for node in &deficit_graph.nodes {
            assert!(!node.share_pct.is_nan());
            assert!(!node.height.is_nan());
        }

        // 4. Gross vs Net toggle with refund inside expense category
        let mut refund_snapshot = snapshot.clone();
        refund_snapshot.transactions.push(TransactionRecord {
            id: "t5".into(),
            account_id: "acc_1".into(),
            category_id: "cat_exp".into(),
            tx_type: TxType::Income,
            status: "posted".into(),
            amount_minor: 20_000,
            date: "2026-11-05".into(),
            description: "Refund".into(),
            member_id: None,
            is_shared: true,
            transfer_pair_id: None,
            has_split_children: false,
            split_transaction_id: None,
            tag_ids: vec![],
        });
        let mut net_filter = AnalyticsFilter::default_for("2026-11-25");
        net_filter.flow_basis = FlowBasis::Net;
        let net_graph = compute_cash_flow_sankey(&refund_snapshot, &net_filter).unwrap();
        assert_eq!(net_graph.total_inflow_minor, 500_000);
        assert_eq!(net_graph.total_outflow_minor, 430_000);

        let mut gross_filter = AnalyticsFilter::default_for("2026-11-25");
        gross_filter.flow_basis = FlowBasis::Gross;
        let gross_graph = compute_cash_flow_sankey(&refund_snapshot, &gross_filter).unwrap();
        assert_eq!(gross_graph.total_inflow_minor, 520_000);
        assert_eq!(gross_graph.total_outflow_minor, 450_000);
    }
}
