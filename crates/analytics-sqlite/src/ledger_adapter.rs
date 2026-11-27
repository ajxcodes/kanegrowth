use analytics_domain::error::AnalyticsError;
use analytics_domain::filter::{AnalyticsFilter, AttributionMode, DrilldownCriteria};
use analytics_domain::model::{
    AccountGroup, AccountRecord, CategoryRecord, EnvelopeType, LedgerSnapshot, MemberRecord,
    RecurringRuleRecord, TagRecord, TransactionRecord, TxType,
};
use analytics_domain::ports::AnalyticsLedgerPort;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, ToSql};
use std::collections::HashMap;

pub struct SqliteAnalyticsAdapter<'a> {
    conn: &'a Connection,
}

impl<'a> SqliteAnalyticsAdapter<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    fn load_transaction_tags(&self) -> Result<HashMap<String, Vec<String>>, AnalyticsError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT transactionId, tagId FROM transaction_tags ORDER BY transactionId, tagId",
            )
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
        for r in rows {
            let (tx_id, tag_id) = r.map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            map.entry(tx_id).or_default().push(tag_id);
        }
        Ok(map)
    }

    fn build_transaction_query(
        filter: &AnalyticsFilter,
        date_bounds: Option<(&str, &str)>,
        criteria: Option<&DrilldownCriteria>,
        respect_transfer_flag: bool,
    ) -> (String, Vec<SqlValue>) {
        let mut clauses: Vec<String> = vec![
            "t.deletedAt IS NULL".to_string(),
            "t.status != 'draft'".to_string(),
            "t.hasSplitChildren = 0".to_string(),
        ];
        let mut params: Vec<SqlValue> = Vec::new();

        if let Some(ws) = &filter.workspace_id {
            clauses.push("t.workspaceId = ?".to_string());
            params.push(SqlValue::Text(ws.clone()));
        }

        if let Some((start_date, end_date)) = date_bounds {
            clauses.push("substr(t.date, 1, 10) >= ?".to_string());
            params.push(SqlValue::Text(start_date.to_string()));
            clauses.push("substr(t.date, 1, 10) <= ?".to_string());
            params.push(SqlValue::Text(end_date.to_string()));
        }

        if let Some(c) = criteria {
            if c.only_transfers {
                clauses.push("(t.type = 'transfer' OR t.transferPairId IS NOT NULL)".to_string());
            } else if respect_transfer_flag && !filter.include_transfers {
                clauses.push("(t.type != 'transfer' AND t.transferPairId IS NULL)".to_string());
            }
            if let Some(cid) = &c.category_id {
                clauses.push("t.categoryId = ?".to_string());
                params.push(SqlValue::Text(cid.clone()));
            }
            if let Some(period) = &c.period {
                clauses.push("substr(t.date, 1, 7) = ?".to_string());
                params.push(SqlValue::Text(period.clone()));
            }
        } else if respect_transfer_flag && !filter.include_transfers {
            clauses.push("(t.type != 'transfer' AND t.transferPairId IS NULL)".to_string());
        }

        if !filter.account_ids.is_empty() {
            let ph = vec!["?"; filter.account_ids.len()].join(", ");
            clauses.push(format!("t.accountId IN ({ph})"));
            for id in &filter.account_ids {
                params.push(SqlValue::Text(id.clone()));
            }
        }

        if !filter.category_ids.is_empty() {
            let ph = vec!["?"; filter.category_ids.len()].join(", ");
            clauses.push(format!("t.categoryId IN ({ph})"));
            for id in &filter.category_ids {
                params.push(SqlValue::Text(id.clone()));
            }
        }

        if !filter.member_ids.is_empty() {
            let ph = vec!["?"; filter.member_ids.len()].join(", ");
            clauses.push(format!("t.memberId IN ({ph})"));
            for id in &filter.member_ids {
                params.push(SqlValue::Text(id.clone()));
            }
        }

        match filter.attribution_mode {
            AttributionMode::All => {}
            AttributionMode::Shared => clauses.push("t.isShared = 1".to_string()),
            AttributionMode::Individual => clauses.push("t.isShared = 0".to_string()),
        }

        if !filter.tag_ids.is_empty() {
            let ph = vec!["?"; filter.tag_ids.len()].join(", ");
            clauses.push(format!(
                "EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transactionId = t._id AND tt.tagId IN ({ph}))"
            ));
            for id in &filter.tag_ids {
                params.push(SqlValue::Text(id.clone()));
            }
        }

        let sql = format!(
            "SELECT t._id, t.accountId, t.categoryId, t.type, t.status, t.amount, t.date, t.data, \
             t.memberId, t.isShared, t.transferPairId, t.hasSplitChildren, t.splitTransactionId, t.tagsJson \
             FROM transactions t WHERE {} ORDER BY t.date DESC, t._id ASC",
            clauses.join(" AND ")
        );
        (sql, params)
    }

    fn query_transactions(
        &self,
        sql: &str,
        params: &[SqlValue],
        tag_map: &HashMap<String, Vec<String>>,
    ) -> Result<Vec<TransactionRecord>, AnalyticsError> {
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
        let refs: Vec<&dyn ToSql> = params.iter().map(|v| v as &dyn ToSql).collect();
        let rows = stmt
            .query_map(refs.as_slice(), |row| {
                let id: String = row.get(0)?;
                let account_id: String = row.get(1)?;
                let category_id: String = row.get(2)?;
                let tx_type_str: String = row.get(3)?;
                let status: String = row.get(4)?;
                let amount_minor: i64 = row.get(5)?;
                let date: String = row.get(6)?;
                let data_json: String = row.get(7)?;
                let member_id: Option<String> = row.get(8)?;
                let is_shared_int: i64 = row.get(9)?;
                let transfer_pair_id: Option<String> = row.get(10)?;
                let has_split_int: i64 = row.get(11)?;
                let split_transaction_id: Option<String> = row.get(12)?;
                let tags_json: String = row.get(13)?;

                let description = serde_json::from_str::<serde_json::Value>(&data_json)
                    .ok()
                    .and_then(|v| {
                        v.get("description")
                            .or_else(|| v.get("note"))
                            .and_then(|d| d.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default();

                let tag_ids = tag_map.get(&id).cloned().unwrap_or_else(|| {
                    serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default()
                });

                Ok(TransactionRecord {
                    id,
                    account_id,
                    category_id,
                    tx_type: TxType::parse(&tx_type_str),
                    status,
                    amount_minor,
                    date,
                    description,
                    member_id,
                    is_shared: is_shared_int != 0,
                    transfer_pair_id,
                    has_split_children: has_split_int != 0,
                    split_transaction_id,
                    tag_ids,
                })
            })
            .map_err(|e| AnalyticsError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AnalyticsError::Storage(e.to_string()))
    }
}

impl<'a> AnalyticsLedgerPort for SqliteAnalyticsAdapter<'a> {
    fn load_ledger_snapshot(
        &self,
        filter: &AnalyticsFilter,
    ) -> Result<LedgerSnapshot, AnalyticsError> {
        let mut accounts = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT _id, name, type, accountGroup, currency, CAST(ROUND(currentBalance) AS INTEGER), \
                     isLiability, interestRateBps, minimumPaymentMinor \
                     FROM accounts WHERE deletedAt IS NULL AND isArchived = 0 ORDER BY name ASC",
                )
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(AccountRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        account_type: row.get(2)?,
                        account_group: AccountGroup::parse(&row.get::<_, String>(3)?),
                        currency: row.get(4)?,
                        current_balance_minor: row.get(5)?,
                        is_liability: row.get::<_, i64>(6)? != 0,
                        interest_rate_bps: row.get(7)?,
                        minimum_payment_minor: row.get(8)?,
                    })
                })
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            for r in rows {
                accounts.push(r.map_err(|e| AnalyticsError::Storage(e.to_string()))?);
            }
        }

        let mut categories = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT _id, name, envelopeType, monthlyTargetMinor \
                     FROM categories WHERE deletedAt IS NULL AND isArchived = 0 ORDER BY name ASC",
                )
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(CategoryRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        envelope_type: EnvelopeType::parse(&row.get::<_, String>(2)?),
                        monthly_target_minor: row.get(3)?,
                    })
                })
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            for r in rows {
                categories.push(r.map_err(|e| AnalyticsError::Storage(e.to_string()))?);
            }
        }

        let mut tags = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT _id, name FROM tags WHERE deletedAt IS NULL ORDER BY name ASC")
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(TagRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                })
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            for r in rows {
                tags.push(r.map_err(|e| AnalyticsError::Storage(e.to_string()))?);
            }
        }

        let mut members = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT _id, name, role, color FROM household_members \
                     WHERE deletedAt IS NULL AND isArchived = 0 ORDER BY name ASC",
                )
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(MemberRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        role: row.get(2)?,
                        color: row.get(3)?,
                    })
                })
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            for r in rows {
                members.push(r.map_err(|e| AnalyticsError::Storage(e.to_string()))?);
            }
        }

        let mut recurring_rules = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT _id, accountId, categoryId, isActive, data FROM recurringRules \
                     WHERE deletedAt IS NULL AND isArchived = 0",
                )
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    let id: String = row.get(0)?;
                    let account_id: String = row.get(1)?;
                    let category_id: String = row.get(2)?;
                    let is_active = row.get::<_, i64>(3)? != 0;
                    let data_json: String = row.get(4)?;
                    let v = serde_json::from_str::<serde_json::Value>(&data_json)
                        .unwrap_or(serde_json::Value::Null);
                    let tx_type =
                        TxType::parse(v.get("type").and_then(|t| t.as_str()).unwrap_or("expense"));
                    let amount_minor = v
                        .get("amountMinor")
                        .or_else(|| v.get("amount"))
                        .and_then(|a| a.as_i64())
                        .unwrap_or(0);
                    let cadence = v
                        .get("cadence")
                        .and_then(|c| c.as_str())
                        .unwrap_or("monthly")
                        .to_string();
                    Ok(RecurringRuleRecord {
                        id,
                        account_id,
                        category_id,
                        tx_type,
                        amount_minor,
                        cadence,
                        is_active,
                    })
                })
                .map_err(|e| AnalyticsError::Storage(e.to_string()))?;
            for r in rows {
                recurring_rules.push(r.map_err(|e| AnalyticsError::Storage(e.to_string()))?);
            }
        }

        let tag_map = self.load_transaction_tags()?;
        // Load across full history (without date clipping) so rolling average / YoY / net worth reconstruction work
        let (sql, params) = Self::build_transaction_query(filter, None, None, false);
        let transactions = self.query_transactions(&sql, &params, &tag_map)?;

        Ok(LedgerSnapshot {
            accounts,
            categories,
            tags,
            members,
            recurring_rules,
            transactions,
        })
    }

    fn list_drilldown_transactions(
        &self,
        filter: &AnalyticsFilter,
        criteria: &DrilldownCriteria,
    ) -> Result<Vec<TransactionRecord>, AnalyticsError> {
        let (start_date, end_date) = filter.resolved_date_bounds()?;
        let tag_map = self.load_transaction_tags()?;
        let (sql, params) = Self::build_transaction_query(
            filter,
            Some((&start_date, &end_date)),
            Some(criteria),
            !criteria.only_transfers,
        );
        self.query_transactions(&sql, &params, &tag_map)
    }
}
