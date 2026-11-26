use crate::error::AnalyticsError;
use crate::filter::{AnalyticsFilter, DrilldownCriteria, SavedAnalyticsView};
use crate::model::{
    CashFlowSankeyGraph, CategoryTrendsReport, DebtPayoffOptions, NetWorthAndDebtReport,
    TransactionRecord,
};
use crate::net_worth::compute_net_worth_and_debt;
use crate::ports::{AnalyticsLedgerPort, SavedViewRepositoryPort};
use crate::sankey::compute_cash_flow_sankey;
use crate::trends::compute_category_trends;

pub struct AnalyticsUseCases<'a, L: AnalyticsLedgerPort, S: SavedViewRepositoryPort> {
    ledger: &'a L,
    saved_views: &'a S,
}

impl<'a, L: AnalyticsLedgerPort, S: SavedViewRepositoryPort> AnalyticsUseCases<'a, L, S> {
    pub fn new(ledger: &'a L, saved_views: &'a S) -> Self {
        Self {
            ledger,
            saved_views,
        }
    }

    pub fn get_cash_flow_sankey(
        &self,
        filter: &AnalyticsFilter,
    ) -> Result<CashFlowSankeyGraph, AnalyticsError> {
        let snapshot = self.ledger.load_ledger_snapshot(filter)?;
        compute_cash_flow_sankey(&snapshot, filter)
    }

    pub fn get_category_trends(
        &self,
        filter: &AnalyticsFilter,
        rolling_window: usize,
    ) -> Result<CategoryTrendsReport, AnalyticsError> {
        let snapshot = self.ledger.load_ledger_snapshot(filter)?;
        compute_category_trends(&snapshot, filter, rolling_window)
    }

    pub fn get_net_worth_projection(
        &self,
        filter: &AnalyticsFilter,
        options: &DebtPayoffOptions,
    ) -> Result<NetWorthAndDebtReport, AnalyticsError> {
        let snapshot = self.ledger.load_ledger_snapshot(filter)?;
        compute_net_worth_and_debt(&snapshot, filter, options)
    }

    pub fn list_drilldown_transactions(
        &self,
        filter: &AnalyticsFilter,
        criteria: &DrilldownCriteria,
    ) -> Result<Vec<TransactionRecord>, AnalyticsError> {
        self.ledger.list_drilldown_transactions(filter, criteria)
    }

    pub fn list_saved_views(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<Vec<SavedAnalyticsView>, AnalyticsError> {
        self.saved_views.list_saved_views(workspace_id)
    }

    pub fn save_view(
        &self,
        view: &SavedAnalyticsView,
    ) -> Result<SavedAnalyticsView, AnalyticsError> {
        self.saved_views.save_view(view)
    }

    pub fn delete_view(&self, id: &str) -> Result<(), AnalyticsError> {
        self.saved_views.delete_view(id)
    }
}
