use analytics_domain::filter::{
    AnalyticsFilter, AttributionMode, DateRangePreset, DrilldownCriteria, SavedAnalyticsView,
};
use analytics_domain::model::{
    AccountRecord, CategoryRecord, DebtPayoffOptions, MemberRecord, RecurringRuleRecord, TagRecord,
    TransactionRecord,
};
use analytics_domain::use_cases::AnalyticsUseCases;
use analytics_sqlite::{
    open_encrypted_connection, run_migrations, SqliteAnalyticsAdapter, SqliteSavedViewAdapter,
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::path::PathBuf;

const VALID_KEY_HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WRONG_KEY_HEX: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

struct TempDbDir(PathBuf);

impl TempDbDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kanegrowth-sqlcipher-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn db_path(&self) -> PathBuf {
        self.0.join("kanegrowth.sqlite3")
    }
}

impl Drop for TempDbDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HouseholdFixture {
    as_of_date: String,
    workspace_id: String,
    user_id: String,
    accounts: Vec<AccountRecord>,
    categories: Vec<CategoryRecord>,
    tags: Vec<TagRecord>,
    members: Vec<MemberRecord>,
    recurring_rules: Vec<RecurringRuleRecord>,
    transactions: Vec<TransactionRecord>,
}

fn seed_fixture(conn: &Connection, fixture: &HouseholdFixture) {
    let now = format!("{}T12:00:00Z", fixture.as_of_date);
    for m in &fixture.members {
        conn.execute(
            "INSERT INTO household_members (_id, workspaceId, name, role, color, isArchived, updatedAt, deletedAt) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, NULL)",
            params![m.id, fixture.workspace_id, m.name, m.role, m.color, now],
        )
        .unwrap();
    }
    for a in &fixture.accounts {
        conn.execute(
            "INSERT INTO accounts (_id, userId, workspaceId, name, type, currency, currentBalance, isArchived, \
             accountGroup, isLiability, interestRateBps, minimumPaymentMinor, data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, '{}', ?12, NULL, ?12, 0, 'synced')",
            params![
                a.id,
                fixture.user_id,
                fixture.workspace_id,
                a.name,
                a.account_type,
                a.currency,
                a.current_balance_minor,
                a.account_group.as_str(),
                if a.is_liability { 1 } else { 0 },
                a.interest_rate_bps,
                a.minimum_payment_minor,
                now
            ],
        )
        .unwrap();
    }
    for c in &fixture.categories {
        let env_str = serde_json::to_value(c.envelope_type)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        conn.execute(
            "INSERT INTO categories (_id, userId, masterCategoryId, name, isArchived, envelopeType, monthlyTargetMinor, \
             data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState) \
             VALUES (?1, ?2, NULL, ?3, 0, ?4, ?5, '{}', ?6, NULL, ?6, 0, 'synced')",
            params![
                c.id,
                fixture.user_id,
                c.name,
                env_str,
                c.monthly_target_minor,
                now
            ],
        )
        .unwrap();
    }
    for t in &fixture.tags {
        conn.execute(
            "INSERT INTO tags (_id, userId, name, data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState) \
             VALUES (?1, ?2, ?3, '{}', ?4, NULL, ?4, 0, 'synced')",
            params![t.id, fixture.user_id, t.name, now],
        )
        .unwrap();
    }
    for r in &fixture.recurring_rules {
        let data = serde_json::json!({
            "type": r.tx_type,
            "amountMinor": r.amount_minor,
            "cadence": r.cadence,
        })
        .to_string();
        conn.execute(
            "INSERT INTO recurringRules (_id, userId, workspaceId, accountId, categoryId, nextDueDate, isActive, isArchived, \
             data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, NULL, ?9, 0, 'synced')",
            params![
                r.id,
                fixture.user_id,
                fixture.workspace_id,
                r.account_id,
                r.category_id,
                fixture.as_of_date,
                if r.is_active { 1 } else { 0 },
                data,
                now
            ],
        )
        .unwrap();
    }
    for tx in &fixture.transactions {
        let tx_type_str = serde_json::to_value(tx.tx_type)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        let data = serde_json::json!({ "description": tx.description }).to_string();
        let tags_json = serde_json::to_string(&tx.tag_ids).unwrap();
        conn.execute(
            "INSERT INTO transactions (_id, userId, workspaceId, accountId, categoryId, type, status, amount, date, clearedStatus, \
             memberId, isShared, transferPairId, hasSplitChildren, splitTransactionId, tagsJson, data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'cleared', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL, ?17, 0, 'synced')",
            params![
                tx.id,
                fixture.user_id,
                fixture.workspace_id,
                tx.account_id,
                tx.category_id,
                tx_type_str,
                tx.status,
                tx.amount_minor,
                tx.date,
                tx.member_id,
                if tx.is_shared { 1 } else { 0 },
                tx.transfer_pair_id,
                if tx.has_split_children { 1 } else { 0 },
                tx.split_transaction_id,
                tags_json,
                data,
                now
            ],
        )
        .unwrap();
        for tag_id in &tx.tag_ids {
            conn.execute(
                "INSERT OR IGNORE INTO transaction_tags (transactionId, tagId) VALUES (?1, ?2)",
                params![tx.id, tag_id],
            )
            .unwrap();
        }
    }
}

#[test]
fn encrypted_sqlcipher_filters_all_dimensions_matches_drilldown_and_persists_saved_views() {
    let dir = TempDbDir::new("integration");
    let db_path = dir.db_path();
    let raw = include_str!("../../../shared/fixtures/analytics/household_fixture.json");
    let fixture: HouseholdFixture = serde_json::from_str(raw).unwrap();

    // 1. Create encrypted SQLCipher DB, migrate 0001-0005, seed fixture, and save a view
    {
        let conn = open_encrypted_connection(&db_path, VALID_KEY_HEX).unwrap();
        run_migrations(&conn).unwrap();
        seed_fixture(&conn, &fixture);

        let ledger = SqliteAnalyticsAdapter::new(&conn);
        let saved_views = SqliteSavedViewAdapter::new(&conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &saved_views);

        // Intersect all 5 dimensions: account, category, tag, member, attribution_mode (individual), date_range
        let mut filter = AnalyticsFilter::default_for(&fixture.as_of_date);
        filter.workspace_id = Some(fixture.workspace_id.clone());
        filter.account_ids = vec!["acc_card_b".into()];
        filter.category_ids = vec!["cat_dining".into()];
        filter.tag_ids = vec!["tag_discretionary".into()];
        filter.member_ids = vec!["mem_sam".into()];
        filter.attribution_mode = AttributionMode::Individual;
        filter.date_range_preset = DateRangePreset::ThisMonth;

        let sankey = use_cases.get_cash_flow_sankey(&filter).unwrap();
        // Dining in 2026-11 has 55000 expense and 3000 refund -> 52000 net outflow
        assert_eq!(sankey.total_outflow_minor, 52_000);

        let trends = use_cases.get_category_trends(&filter, 3).unwrap();
        let nov_dining = trends
            .series
            .iter()
            .find(|p| p.period == "2026-11" && p.category_id == "cat_dining")
            .unwrap();
        assert_eq!(nov_dining.amount_minor, 52_000);

        // Drill-down net sum matches Sankey & Trends exactly
        let drilldown = use_cases
            .list_drilldown_transactions(
                &filter,
                &DrilldownCriteria {
                    category_id: Some("cat_dining".into()),
                    period: Some("2026-11".into()),
                    only_transfers: false,
                },
            )
            .unwrap();
        let drilldown_net: i64 = drilldown
            .iter()
            .map(|t| match t.tx_type {
                analytics_domain::model::TxType::Expense => t.amount_minor,
                analytics_domain::model::TxType::Income => -t.amount_minor,
                analytics_domain::model::TxType::Transfer => 0,
            })
            .sum();
        assert_eq!(drilldown_net, 52_000);

        // Verify shared vs individual attribution changes results cleanly
        let mut shared_filter = filter.clone();
        shared_filter.attribution_mode = AttributionMode::Shared;
        let shared_sankey = use_cases.get_cash_flow_sankey(&shared_filter).unwrap();
        assert_eq!(shared_sankey.total_outflow_minor, 0);

        // Verify Net Worth + Debt Payoff works against SQLCipher
        let mut nw_filter = AnalyticsFilter::default_for(&fixture.as_of_date);
        nw_filter.workspace_id = Some(fixture.workspace_id.clone());
        nw_filter.date_range_preset = DateRangePreset::Last12Months;
        let nw = use_cases
            .get_net_worth_projection(&nw_filter, &DebtPayoffOptions::default())
            .unwrap();
        assert_eq!(nw.timeline.last().unwrap().net_worth_minor, 7_900_000);

        // Persist SavedAnalyticsView
        let view = SavedAnalyticsView {
            id: "view_sam_dining".into(),
            user_id: fixture.user_id.clone(),
            workspace_id: Some(fixture.workspace_id.clone()),
            name: "Sam Individual Dining".into(),
            chart_tab: "trends".into(),
            filter: filter.clone(),
            is_pinned: true,
            created_at: "2026-11-25T12:00:00Z".into(),
            updated_at: "2026-11-25T12:00:00Z".into(),
        };
        use_cases.save_view(&view).unwrap();
    }

    // 2. Wrong PRAGMA key must fail to open encrypted SQLCipher DB
    assert!(open_encrypted_connection(&db_path, WRONG_KEY_HEX).is_err());

    // 3. Reopen with valid key and verify SavedAnalyticsView persisted across reopen
    {
        let conn = open_encrypted_connection(&db_path, VALID_KEY_HEX).unwrap();
        let saved_views = SqliteSavedViewAdapter::new(&conn);
        let ledger = SqliteAnalyticsAdapter::new(&conn);
        let use_cases = AnalyticsUseCases::new(&ledger, &saved_views);

        let loaded = use_cases
            .list_saved_views(Some(&fixture.workspace_id))
            .unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "view_sam_dining");
        assert_eq!(loaded[0].name, "Sam Individual Dining");
        assert_eq!(loaded[0].filter.member_ids, vec!["mem_sam".to_string()]);
        assert_eq!(
            loaded[0].filter.attribution_mode,
            AttributionMode::Individual
        );
    }
}
