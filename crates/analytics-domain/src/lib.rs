pub mod debt_payoff;
pub mod error;
pub mod filter;
pub mod model;
pub mod net_worth;
pub mod ports;
pub mod sankey;
pub mod trends;
pub mod use_cases;

#[cfg(test)]
mod tests {
    use crate::error::AnalyticsError;
    use crate::filter::{
        AnalyticsFilter, DateRangePreset, DrilldownCriteria, FlowBasis, SavedAnalyticsView,
    };
    use crate::model::{
        AccountRecord, CategoryRecord, DebtPayoffOptions, LedgerSnapshot, MemberRecord,
        RecurringRuleRecord, TagRecord, TransactionRecord,
    };
    use crate::ports::{AnalyticsLedgerPort, SavedViewRepositoryPort};
    use crate::use_cases::AnalyticsUseCases;
    use serde::Deserialize;
    use std::cell::RefCell;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureExpectedSankey {
        total_inflow_minor: i64,
        total_outflow_minor: i64,
        net_savings_minor: i64,
        excluded_transfer_minor: i64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureExpectedDining {
        amount_minor: i64,
        rolling_avg_minor: i64,
        prior_year_amount_minor: i64,
        yoy_delta_minor: i64,
        overage_minor: i64,
        is_over_threshold: bool,
        is_anomaly: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureExpectedNetWorth {
        assets_minor: i64,
        liabilities_minor: i64,
        net_worth_minor: i64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureExpected {
        this_month_net_sankey: FixtureExpectedSankey,
        this_month_gross_sankey: FixtureExpectedSankey,
        dining_trend202611: FixtureExpectedDining,
        latest_net_worth: FixtureExpectedNetWorth,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HouseholdFixture {
        as_of_date: String,
        accounts: Vec<AccountRecord>,
        categories: Vec<CategoryRecord>,
        tags: Vec<TagRecord>,
        members: Vec<MemberRecord>,
        recurring_rules: Vec<RecurringRuleRecord>,
        transactions: Vec<TransactionRecord>,
        expected: FixtureExpected,
    }

    struct MockLedgerPort {
        snapshot: LedgerSnapshot,
    }

    impl AnalyticsLedgerPort for MockLedgerPort {
        fn load_ledger_snapshot(
            &self,
            _filter: &AnalyticsFilter,
        ) -> Result<LedgerSnapshot, AnalyticsError> {
            Ok(self.snapshot.clone())
        }

        fn list_drilldown_transactions(
            &self,
            filter: &AnalyticsFilter,
            criteria: &DrilldownCriteria,
        ) -> Result<Vec<TransactionRecord>, AnalyticsError> {
            let (start_date, end_date) = filter.resolved_date_bounds()?;
            Ok(self
                .snapshot
                .transactions
                .iter()
                .filter(|tx| {
                    if criteria.only_transfers {
                        if !AnalyticsFilter::is_transfer(tx) {
                            return false;
                        }
                        if !filter.matches_transaction(tx, &start_date, &end_date, false) {
                            return false;
                        }
                    } else if !filter.matches_transaction(tx, &start_date, &end_date, true) {
                        return false;
                    }
                    if let Some(cid) = &criteria.category_id {
                        if &tx.category_id != cid {
                            return false;
                        }
                    }
                    if let Some(period) = &criteria.period {
                        if tx.date.get(0..7) != Some(period.as_str()) {
                            return false;
                        }
                    }
                    true
                })
                .cloned()
                .collect())
        }
    }

    struct MockSavedViewPort {
        views: RefCell<Vec<SavedAnalyticsView>>,
    }

    impl SavedViewRepositoryPort for MockSavedViewPort {
        fn list_saved_views(
            &self,
            _workspace_id: Option<&str>,
        ) -> Result<Vec<SavedAnalyticsView>, AnalyticsError> {
            Ok(self.views.borrow().clone())
        }

        fn save_view(
            &self,
            view: &SavedAnalyticsView,
        ) -> Result<SavedAnalyticsView, AnalyticsError> {
            let mut list = self.views.borrow_mut();
            list.retain(|v| v.id != view.id);
            list.push(view.clone());
            Ok(view.clone())
        }

        fn delete_view(&self, id: &str) -> Result<(), AnalyticsError> {
            self.views.borrow_mut().retain(|v| v.id != id);
            Ok(())
        }
    }

    #[test]
    fn hexagonal_use_cases_execute_with_in_memory_mock_ports() {
        let raw = include_str!("../../../shared/fixtures/analytics/household_fixture.json");
        let fixture: HouseholdFixture = serde_json::from_str(raw).unwrap();
        let snapshot = LedgerSnapshot {
            accounts: fixture.accounts,
            categories: fixture.categories,
            tags: fixture.tags,
            members: fixture.members,
            recurring_rules: fixture.recurring_rules,
            transactions: fixture.transactions,
        };

        let ledger = MockLedgerPort { snapshot };
        let views = MockSavedViewPort {
            views: RefCell::new(Vec::new()),
        };
        let use_cases = AnalyticsUseCases::new(&ledger, &views);

        // 1. Sankey (Net & Gross) matches canonical fixture expectations
        let net_filter = AnalyticsFilter::default_for(&fixture.as_of_date);
        let net_sankey = use_cases.get_cash_flow_sankey(&net_filter).unwrap();
        assert_eq!(
            net_sankey.total_inflow_minor,
            fixture.expected.this_month_net_sankey.total_inflow_minor
        );
        assert_eq!(
            net_sankey.total_outflow_minor,
            fixture.expected.this_month_net_sankey.total_outflow_minor
        );
        assert_eq!(
            net_sankey.net_savings_minor,
            fixture.expected.this_month_net_sankey.net_savings_minor
        );
        assert_eq!(
            net_sankey.excluded_transfer_minor,
            fixture
                .expected
                .this_month_net_sankey
                .excluded_transfer_minor
        );

        let mut gross_filter = net_filter.clone();
        gross_filter.flow_basis = FlowBasis::Gross;
        let gross_sankey = use_cases.get_cash_flow_sankey(&gross_filter).unwrap();
        assert_eq!(
            gross_sankey.total_inflow_minor,
            fixture.expected.this_month_gross_sankey.total_inflow_minor
        );
        assert_eq!(
            gross_sankey.total_outflow_minor,
            fixture.expected.this_month_gross_sankey.total_outflow_minor
        );

        // 2. Category trends matches canonical fixture Dining Out expectations
        let mut trends_filter = AnalyticsFilter::default_for(&fixture.as_of_date);
        trends_filter.date_range_preset = DateRangePreset::Last12Months;
        let trends = use_cases.get_category_trends(&trends_filter, 3).unwrap();
        let dining = trends
            .series
            .iter()
            .find(|p| p.period == "2026-11" && p.category_id == "cat_dining")
            .unwrap();
        assert_eq!(
            dining.amount_minor,
            fixture.expected.dining_trend202611.amount_minor
        );
        assert_eq!(
            dining.rolling_avg_minor,
            fixture.expected.dining_trend202611.rolling_avg_minor
        );
        assert_eq!(
            dining.prior_year_amount_minor,
            Some(fixture.expected.dining_trend202611.prior_year_amount_minor)
        );
        assert_eq!(
            dining.yoy_delta_minor,
            Some(fixture.expected.dining_trend202611.yoy_delta_minor)
        );
        assert_eq!(
            dining.overage_minor,
            fixture.expected.dining_trend202611.overage_minor
        );
        assert_eq!(
            dining.is_over_threshold,
            fixture.expected.dining_trend202611.is_over_threshold
        );
        assert_eq!(
            dining.is_anomaly,
            fixture.expected.dining_trend202611.is_anomaly
        );

        // 3. Net Worth & Debt Payoff matches canonical fixture latest net worth
        let nw = use_cases
            .get_net_worth_projection(&trends_filter, &DebtPayoffOptions::default())
            .unwrap();
        let latest = nw.timeline.last().unwrap();
        assert_eq!(
            latest.assets_minor,
            fixture.expected.latest_net_worth.assets_minor
        );
        assert_eq!(
            latest.liabilities_minor,
            fixture.expected.latest_net_worth.liabilities_minor
        );
        assert_eq!(
            latest.net_worth_minor,
            fixture.expected.latest_net_worth.net_worth_minor
        );
        assert!(nw.avalanche.total_interest_paid_minor < nw.snowball.total_interest_paid_minor);

        // 4. Saved views round-trip via mock port
        let view = SavedAnalyticsView {
            id: "view_1".into(),
            user_id: "user_1".into(),
            workspace_id: None,
            name: "Monthly Review".into(),
            chart_tab: "sankey".into(),
            filter: net_filter,
            is_pinned: true,
            created_at: "2026-11-25T12:00:00Z".into(),
            updated_at: "2026-11-25T12:00:00Z".into(),
        };
        use_cases.save_view(&view).unwrap();
        assert_eq!(use_cases.list_saved_views(None).unwrap().len(), 1);
        use_cases.delete_view("view_1").unwrap();
        assert!(use_cases.list_saved_views(None).unwrap().is_empty());
    }
}
