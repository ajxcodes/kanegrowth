use crate::db::DbState;
use analytics_domain::filter::{AnalyticsFilter, DrilldownCriteria, SavedAnalyticsView};
use analytics_domain::model::{
    CashFlowSankeyGraph, CategoryTrendsReport, DebtPayoffOptions, NetWorthAndDebtReport,
    TransactionRecord,
};
use analytics_domain::use_cases::AnalyticsUseCases;
use analytics_sqlite::{SqliteAnalyticsAdapter, SqliteSavedViewAdapter};
use tauri::State;

#[tauri::command]
pub fn analytics_get_cash_flow_sankey(
    state: State<DbState>,
    filter: AnalyticsFilter,
) -> Result<CashFlowSankeyGraph, String> {
    state.with_connection(|conn| {
        let ledger = SqliteAnalyticsAdapter::new(conn);
        let views = SqliteSavedViewAdapter::new(conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &views);
        use_cases
            .get_cash_flow_sankey(&filter)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn analytics_get_category_trends(
    state: State<DbState>,
    filter: AnalyticsFilter,
    rolling_window: Option<usize>,
) -> Result<CategoryTrendsReport, String> {
    state.with_connection(|conn| {
        let ledger = SqliteAnalyticsAdapter::new(conn);
        let views = SqliteSavedViewAdapter::new(conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &views);
        use_cases
            .get_category_trends(&filter, rolling_window.unwrap_or(3))
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn analytics_get_net_worth_projection(
    state: State<DbState>,
    filter: AnalyticsFilter,
    options: Option<DebtPayoffOptions>,
) -> Result<NetWorthAndDebtReport, String> {
    state.with_connection(|conn| {
        let ledger = SqliteAnalyticsAdapter::new(conn);
        let views = SqliteSavedViewAdapter::new(conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &views);
        use_cases
            .get_net_worth_projection(&filter, &options.unwrap_or_default())
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn analytics_list_drilldown_transactions(
    state: State<DbState>,
    filter: AnalyticsFilter,
    criteria: DrilldownCriteria,
) -> Result<Vec<TransactionRecord>, String> {
    state.with_connection(|conn| {
        let ledger = SqliteAnalyticsAdapter::new(conn);
        let views = SqliteSavedViewAdapter::new(conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &views);
        use_cases
            .list_drilldown_transactions(&filter, &criteria)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn analytics_list_saved_views(
    state: State<DbState>,
    workspace_id: Option<String>,
) -> Result<Vec<SavedAnalyticsView>, String> {
    state.with_connection(|conn| {
        let ledger = SqliteAnalyticsAdapter::new(conn);
        let views = SqliteSavedViewAdapter::new(conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &views);
        use_cases
            .list_saved_views(workspace_id.as_deref())
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn analytics_save_view(
    state: State<DbState>,
    view: SavedAnalyticsView,
) -> Result<SavedAnalyticsView, String> {
    state.with_connection(|conn| {
        let ledger = SqliteAnalyticsAdapter::new(conn);
        let views = SqliteSavedViewAdapter::new(conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &views);
        use_cases.save_view(&view).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn analytics_delete_view(state: State<DbState>, id: String) -> Result<(), String> {
    state.with_connection(|conn| {
        let ledger = SqliteAnalyticsAdapter::new(conn);
        let views = SqliteSavedViewAdapter::new(conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &views);
        use_cases.delete_view(&id).map_err(|e| e.to_string())
    })
}
