use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountGroup {
    Banking,
    Investment,
    Cash,
    Credit,
    Loan,
}

impl AccountGroup {
    pub fn as_str(&self) -> &'static str {
        match self {
            AccountGroup::Banking => "banking",
            AccountGroup::Investment => "investment",
            AccountGroup::Cash => "cash",
            AccountGroup::Credit => "credit",
            AccountGroup::Loan => "loan",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "investment" | "brokerage" | "retirement" => AccountGroup::Investment,
            "cash" | "savings" => AccountGroup::Cash,
            "credit" | "credit_card" => AccountGroup::Credit,
            "loan" | "mortgage" | "debt" => AccountGroup::Loan,
            _ => AccountGroup::Banking,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeType {
    Income,
    Expense,
    SinkingFund,
    Savings,
    Transfer,
}

impl EnvelopeType {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "income" => EnvelopeType::Income,
            "sinking_fund" => EnvelopeType::SinkingFund,
            "savings" => EnvelopeType::Savings,
            "transfer" => EnvelopeType::Transfer,
            _ => EnvelopeType::Expense,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxType {
    Income,
    Expense,
    Transfer,
}

impl TxType {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "income" => TxType::Income,
            "transfer" => TxType::Transfer,
            _ => TxType::Expense,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    pub name: String,
    pub account_type: String,
    pub account_group: AccountGroup,
    pub currency: String,
    pub current_balance_minor: i64,
    pub is_liability: bool,
    pub interest_rate_bps: i64,
    pub minimum_payment_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRecord {
    pub id: String,
    pub name: String,
    pub envelope_type: EnvelopeType,
    pub monthly_target_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRecord {
    pub id: String,
    pub name: String,
    pub role: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringRuleRecord {
    pub id: String,
    pub account_id: String,
    pub category_id: String,
    pub tx_type: TxType,
    pub amount_minor: i64,
    pub cadence: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRecord {
    pub id: String,
    pub account_id: String,
    pub category_id: String,
    pub tx_type: TxType,
    pub status: String,
    pub amount_minor: i64,
    pub date: String,
    pub description: String,
    pub member_id: Option<String>,
    pub is_shared: bool,
    pub transfer_pair_id: Option<String>,
    pub has_split_children: bool,
    pub split_transaction_id: Option<String>,
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSnapshot {
    pub accounts: Vec<AccountRecord>,
    pub categories: Vec<CategoryRecord>,
    pub tags: Vec<TagRecord>,
    pub members: Vec<MemberRecord>,
    pub recurring_rules: Vec<RecurringRuleRecord>,
    pub transactions: Vec<TransactionRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SankeyNodeKind {
    Income,
    Pool,
    Expense,
    SinkingFund,
    Savings,
    Transfer,
    Surplus,
    Deficit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyNode {
    pub id: String,
    pub label: String,
    pub tier: u8,
    pub kind: SankeyNodeKind,
    pub amount_minor: i64,
    pub share_pct: f64,
    pub tx_count: usize,
    pub category_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SankeyLink {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub amount_minor: i64,
    pub share_pct: f64,
    pub tx_count: usize,
    pub category_id: Option<String>,
    pub flow_kind: SankeyNodeKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashFlowSankeyGraph {
    pub nodes: Vec<SankeyNode>,
    pub links: Vec<SankeyLink>,
    pub total_inflow_minor: i64,
    pub total_outflow_minor: i64,
    pub net_savings_minor: i64,
    pub excluded_transfer_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTrendPoint {
    pub period: String,
    pub category_id: String,
    pub category_name: String,
    pub amount_minor: i64,
    pub rolling_avg_minor: i64,
    pub mom_delta_minor: Option<i64>,
    pub mom_delta_pct: Option<f64>,
    pub prior_year_amount_minor: Option<i64>,
    pub yoy_delta_minor: Option<i64>,
    pub yoy_delta_pct: Option<f64>,
    pub monthly_target_minor: i64,
    pub overage_minor: i64,
    pub is_over_threshold: bool,
    pub is_anomaly: bool,
    pub tx_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTrendSummary {
    pub category_id: String,
    pub category_name: String,
    pub total_amount_minor: i64,
    pub latest_amount_minor: i64,
    pub monthly_target_minor: i64,
    pub anomaly_count: usize,
    pub overage_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTrendsReport {
    pub periods: Vec<String>,
    pub series: Vec<CategoryTrendPoint>,
    pub summaries: Vec<CategoryTrendSummary>,
    pub rolling_window: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthPoint {
    pub period: String,
    pub assets_minor: i64,
    pub liabilities_minor: i64,
    pub net_worth_minor: i64,
    pub by_account_group: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtAccountInput {
    pub id: String,
    pub name: String,
    pub balance_minor: i64,
    pub interest_rate_bps: i64,
    pub minimum_payment_minor: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayoffStrategy {
    Snowball,
    Avalanche,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPayoffOptions {
    pub extra_monthly_minor: i64,
    pub lump_sum_minor: i64,
    pub projection_months: usize,
}

impl Default for DebtPayoffOptions {
    fn default() -> Self {
        Self {
            extra_monthly_minor: 0,
            lump_sum_minor: 0,
            projection_months: 24,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPayoffMonthPoint {
    pub month_index: usize,
    pub period: String,
    pub remaining_balance_minor: i64,
    pub interest_paid_minor: i64,
    pub principal_paid_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPayoffSummary {
    pub strategy: PayoffStrategy,
    pub target_order: Vec<String>,
    pub debt_free_months: usize,
    pub debt_free_date: String,
    pub total_interest_paid_minor: i64,
    pub total_paid_minor: i64,
    pub baseline_interest_minor: i64,
    pub interest_saved_vs_minimum_minor: i64,
    pub schedule: Vec<DebtPayoffMonthPoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPayoffComparison {
    pub snowball: DebtPayoffSummary,
    pub avalanche: DebtPayoffSummary,
    pub interest_saved_by_avalanche_minor: i64,
    pub extra_payment_interest_saved_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthAndDebtReport {
    pub timeline: Vec<NetWorthPoint>,
    pub projection_timeline: Vec<NetWorthPoint>,
    pub snowball: DebtPayoffSummary,
    pub avalanche: DebtPayoffSummary,
    pub interest_saved_by_avalanche_minor: i64,
    pub extra_payment_interest_saved_minor: i64,
    pub warning: Option<String>,
}
