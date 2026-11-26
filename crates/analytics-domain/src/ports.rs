use crate::error::AnalyticsError;
use crate::filter::{AnalyticsFilter, DrilldownCriteria, SavedAnalyticsView};
use crate::model::{LedgerSnapshot, TransactionRecord};

/// Driven Port: reads ledger snapshots and drill-down transactions from persistence.
pub trait AnalyticsLedgerPort {
    fn load_ledger_snapshot(&self, filter: &AnalyticsFilter)
        -> Result<LedgerSnapshot, AnalyticsError>;

    fn list_drilldown_transactions(
        &self,
        filter: &AnalyticsFilter,
        criteria: &DrilldownCriteria,
    ) -> Result<Vec<TransactionRecord>, AnalyticsError>;
}

/// Driven Port: persists and retrieves user-defined saved analytics filter views.
pub trait SavedViewRepositoryPort {
    fn list_saved_views(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<Vec<SavedAnalyticsView>, AnalyticsError>;

    fn save_view(&self, view: &SavedAnalyticsView) -> Result<SavedAnalyticsView, AnalyticsError>;

    fn delete_view(&self, id: &str) -> Result<(), AnalyticsError>;
}
