use crate::error::AnalyticsError;
use crate::model::{TransactionRecord, TxType};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateRangePreset {
    ThisMonth,
    LastMonth,
    Ytd,
    Last12Months,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributionMode {
    All,
    Shared,
    Individual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowBasis {
    Net,
    Gross,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsFilter {
    pub date_range_preset: DateRangePreset,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub as_of_date: String,
    #[serde(default)]
    pub account_ids: Vec<String>,
    #[serde(default)]
    pub category_ids: Vec<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub member_ids: Vec<String>,
    pub attribution_mode: AttributionMode,
    #[serde(default)]
    pub include_transfers: bool,
    pub flow_basis: FlowBasis,
    pub workspace_id: Option<String>,
}

impl AnalyticsFilter {
    pub fn default_for(as_of_date: impl Into<String>) -> Self {
        Self {
            date_range_preset: DateRangePreset::ThisMonth,
            start_date: None,
            end_date: None,
            as_of_date: as_of_date.into(),
            account_ids: Vec::new(),
            category_ids: Vec::new(),
            tag_ids: Vec::new(),
            member_ids: Vec::new(),
            attribution_mode: AttributionMode::All,
            include_transfers: false,
            flow_basis: FlowBasis::Net,
            workspace_id: None,
        }
    }

    /// Resolves `(start_date, end_date)` in `YYYY-MM-DD` format using explicit `as_of_date`.
    pub fn resolved_date_bounds(&self) -> Result<(String, String), AnalyticsError> {
        let (year, month, _day) = parse_ymd(&self.as_of_date)?;
        match self.date_range_preset {
            DateRangePreset::ThisMonth => {
                let start = format!("{year:04}-{month:02}-01");
                let end = format!("{year:04}-{month:02}-{:02}", days_in_month(year, month));
                Ok((start, end))
            }
            DateRangePreset::LastMonth => {
                let (py, pm) = add_months(year, month, -1);
                let start = format!("{py:04}-{pm:02}-01");
                let end = format!("{py:04}-{pm:02}-{:02}", days_in_month(py, pm));
                Ok((start, end))
            }
            DateRangePreset::Ytd => {
                let start = format!("{year:04}-01-01");
                let end = format!("{year:04}-{month:02}-{:02}", days_in_month(year, month));
                Ok((start, end))
            }
            DateRangePreset::Last12Months => {
                let (sy, sm) = add_months(year, month, -11);
                let start = format!("{sy:04}-{sm:02}-01");
                let end = format!("{year:04}-{month:02}-{:02}", days_in_month(year, month));
                Ok((start, end))
            }
            DateRangePreset::Custom => {
                let start = self.start_date.clone().ok_or_else(|| {
                    AnalyticsError::InvalidFilter("custom range requires startDate".into())
                })?;
                let end = self.end_date.clone().ok_or_else(|| {
                    AnalyticsError::InvalidFilter("custom range requires endDate".into())
                })?;
                let _ = parse_ymd(&start)?;
                let _ = parse_ymd(&end)?;
                if start > end {
                    return Err(AnalyticsError::InvalidFilter(
                        "startDate must be <= endDate".into(),
                    ));
                }
                Ok((start, end))
            }
        }
    }

    pub fn is_transfer(tx: &TransactionRecord) -> bool {
        tx.tx_type == TxType::Transfer || tx.transfer_pair_id.is_some()
    }

    /// Evaluates non-date filter predicates (excluding split parents and drafts).
    pub fn matches_dimensions(&self, tx: &TransactionRecord, respect_transfer_flag: bool) -> bool {
        if tx.has_split_children || tx.status == "draft" {
            return false;
        }
        if respect_transfer_flag && !self.include_transfers && Self::is_transfer(tx) {
            return false;
        }
        if !self.account_ids.is_empty() && !self.account_ids.iter().any(|id| id == &tx.account_id) {
            return false;
        }
        if !self.category_ids.is_empty()
            && !self.category_ids.iter().any(|id| id == &tx.category_id)
        {
            return false;
        }
        if !self.tag_ids.is_empty()
            && !self
                .tag_ids
                .iter()
                .any(|tid| tx.tag_ids.iter().any(|t| t == tid))
        {
            return false;
        }
        if !self.member_ids.is_empty() {
            match &tx.member_id {
                Some(mid) if self.member_ids.iter().any(|id| id == mid) => {}
                _ => return false,
            }
        }
        match self.attribution_mode {
            AttributionMode::All => {}
            AttributionMode::Shared => {
                if !tx.is_shared {
                    return false;
                }
            }
            AttributionMode::Individual => {
                if tx.is_shared {
                    return false;
                }
            }
        }
        true
    }

    pub fn matches_transaction(
        &self,
        tx: &TransactionRecord,
        start_date: &str,
        end_date: &str,
        respect_transfer_flag: bool,
    ) -> bool {
        if !self.matches_dimensions(tx, respect_transfer_flag) {
            return false;
        }
        let d = tx.date.get(0..10).unwrap_or(tx.date.as_str());
        d >= start_date && d <= end_date
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAnalyticsView {
    pub id: String,
    pub user_id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub chart_tab: String,
    pub filter: AnalyticsFilter,
    pub is_pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrilldownCriteria {
    pub category_id: Option<String>,
    pub period: Option<String>,
    pub only_transfers: bool,
}

pub fn parse_ymd(date: &str) -> Result<(i32, u32, u32), AnalyticsError> {
    let slice = date.get(0..10).unwrap_or(date);
    let parts: Vec<&str> = slice.split('-').collect();
    if parts.len() != 3 {
        return Err(AnalyticsError::InvalidFilter(format!(
            "invalid YYYY-MM-DD date: {date}"
        )));
    }
    let y: i32 = parts[0]
        .parse()
        .map_err(|_| AnalyticsError::InvalidFilter(format!("invalid year in {date}")))?;
    let m: u32 = parts[1]
        .parse()
        .map_err(|_| AnalyticsError::InvalidFilter(format!("invalid month in {date}")))?;
    let d: u32 = parts[2]
        .parse()
        .map_err(|_| AnalyticsError::InvalidFilter(format!("invalid day in {date}")))?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(AnalyticsError::InvalidFilter(format!(
            "out-of-range date: {date}"
        )));
    }
    Ok((y, m, d))
}

pub fn add_months(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let total = year * 12 + (month as i32 - 1) + delta;
    let ny = total.div_euclid(12);
    let nm = (total.rem_euclid(12) + 1) as u32;
    (ny, nm)
}

pub fn format_ym(year: i32, month: u32) -> String {
    format!("{year:04}-{month:02}")
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

pub fn month_sequence(start_ym: &str, end_ym: &str) -> Result<Vec<String>, AnalyticsError> {
    let (sy, sm, _) = parse_ymd(&format!("{start_ym}-01"))?;
    let (ey, em, _) = parse_ymd(&format!("{end_ym}-01"))?;
    let mut out = Vec::new();
    let mut cy = sy;
    let mut cm = sm;
    while (cy, cm) <= (ey, em) {
        out.push(format_ym(cy, cm));
        let next = add_months(cy, cm, 1);
        cy = next.0;
        cm = next.1;
        if out.len() > 600 {
            break;
        }
    }
    Ok(out)
}
