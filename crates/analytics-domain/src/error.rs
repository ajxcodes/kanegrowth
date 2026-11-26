use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AnalyticsError {
    #[error("Invalid analytics filter: {0}")]
    InvalidFilter(String),

    #[error("Debt cannot be amortized with current payments: {0}")]
    NonAmortizingDebt(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("Analytics entity not found: {0}")]
    NotFound(String),
}
