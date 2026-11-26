use analytics_domain::error::AnalyticsError;
use analytics_domain::filter::{AnalyticsFilter, SavedAnalyticsView};
use analytics_domain::ports::SavedViewRepositoryPort;
use rusqlite::{params, Connection};

pub struct SqliteSavedViewAdapter<'a> {
    conn: &'a Connection,
}

impl<'a> SqliteSavedViewAdapter<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }
}

impl<'a> SavedViewRepositoryPort for SqliteSavedViewAdapter<'a> {
    fn list_saved_views(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<Vec<SavedAnalyticsView>, AnalyticsError> {
        let sql = if workspace_id.is_some() {
            "SELECT _id, userId, workspaceId, name, chartTab, filterJson, isPinned, createdAt, updatedAt \
             FROM saved_analytics_views WHERE deletedAt IS NULL AND workspaceId = ?1 \
             ORDER BY isPinned DESC, updatedAt DESC"
        } else {
            "SELECT _id, userId, workspaceId, name, chartTab, filterJson, isPinned, createdAt, updatedAt \
             FROM saved_analytics_views WHERE deletedAt IS NULL \
             ORDER BY isPinned DESC, updatedAt DESC"
        };

        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<SavedAnalyticsView> {
            let filter_json: String = row.get(5)?;
            let filter: AnalyticsFilter = serde_json::from_str(&filter_json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok(SavedAnalyticsView {
                id: row.get(0)?,
                user_id: row.get(1)?,
                workspace_id: row.get(2)?,
                name: row.get(3)?,
                chart_tab: row.get(4)?,
                filter,
                is_pinned: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        };

        let rows = if let Some(ws) = workspace_id {
            stmt.query_map(params![ws], map_row)
        } else {
            stmt.query_map([], map_row)
        }
        .map_err(|e| AnalyticsError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AnalyticsError::Storage(e.to_string()))
    }

    fn save_view(&self, view: &SavedAnalyticsView) -> Result<SavedAnalyticsView, AnalyticsError> {
        let filter_json = serde_json::to_string(&view.filter)
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;

        self.conn
            .execute(
                "INSERT INTO saved_analytics_views \
                 (_id, userId, workspaceId, name, chartTab, filterJson, isPinned, createdAt, updatedAt, deletedAt) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL) \
                 ON CONFLICT(_id) DO UPDATE SET \
                   name = excluded.name, \
                   chartTab = excluded.chartTab, \
                   filterJson = excluded.filterJson, \
                   isPinned = excluded.isPinned, \
                   updatedAt = excluded.updatedAt, \
                   deletedAt = NULL",
                params![
                    view.id,
                    view.user_id,
                    view.workspace_id,
                    view.name,
                    view.chart_tab,
                    filter_json,
                    if view.is_pinned { 1 } else { 0 },
                    view.created_at,
                    view.updated_at
                ],
            )
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;

        Ok(view.clone())
    }

    fn delete_view(&self, id: &str) -> Result<(), AnalyticsError> {
        self.conn
            .execute(
                "UPDATE saved_analytics_views SET deletedAt = 'deleted' WHERE _id = ?1",
                params![id],
            )
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
        Ok(())
    }
}
