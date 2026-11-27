use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn data(data: T) -> Self {
        Self {
            success: Some(true),
            data: Some(data),
            message: None,
        }
    }
}

pub const LEGAL_TERMS_VERSION: &str = "2026-08-29";
pub const LEGAL_PRIVACY_VERSION: &str = "2026-08-29";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegalVersions {
    #[serde(rename = "termsVersion")]
    pub terms_version: String,
    #[serde(rename = "privacyVersion")]
    pub privacy_version: String,
}

impl LegalVersions {
    pub fn current() -> Self {
        Self {
            terms_version: LEGAL_TERMS_VERSION.to_string(),
            privacy_version: LEGAL_PRIVACY_VERSION.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserDto {
    #[serde(rename = "_id")]
    pub id: String,
    pub email: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    #[serde(rename = "isEmailVerified")]
    pub email_verified: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(rename = "preferredCurrency", skip_serializing_if = "Option::is_none")]
    pub preferred_currency: Option<String>,
    #[serde(rename = "dateFormat", skip_serializing_if = "Option::is_none")]
    pub date_format: Option<String>,
    #[serde(rename = "pageSize", skip_serializing_if = "Option::is_none")]
    pub page_size: Option<i64>,
    #[serde(
        rename = "notificationPreferences",
        skip_serializing_if = "Option::is_none"
    )]
    pub notification_preferences: Option<Value>,
    #[serde(rename = "legalAcceptance", skip_serializing_if = "Option::is_none")]
    pub legal_acceptance: Option<Value>,
    #[serde(rename = "legalVersions")]
    pub legal_versions: LegalVersions,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    #[serde(rename = "fullName")]
    pub full_name: Option<String>,
    pub timezone: Option<String>,
    #[serde(rename = "acceptedTerms")]
    pub accepted_terms: Option<bool>,
    #[serde(rename = "ageAttested")]
    pub age_attested: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
pub struct UpdateUserRequest {
    #[serde(rename = "fullName")]
    pub full_name: Option<String>,
    pub timezone: Option<String>,
    #[serde(rename = "preferredCurrency")]
    pub preferred_currency: Option<String>,
    #[serde(rename = "dateFormat")]
    pub date_format: Option<String>,
    #[serde(rename = "pageSize")]
    pub page_size: Option<i64>,
    #[serde(rename = "notificationPreferences")]
    pub notification_preferences: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct PasswordResetRequest {
    pub email: String,
}

#[derive(Debug, Deserialize)]
pub struct PasswordResetConfirmRequest {
    pub token: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct EmailVerificationConfirmRequest {
    pub token: String,
}

#[derive(Debug, Deserialize)]
pub struct EmailVerificationResendRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteAccountRequest {
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthMessageResponse {
    pub message: String,
    #[serde(rename = "devToken", skip_serializing_if = "Option::is_none")]
    pub dev_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AffectedWorkspace {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountDeletionImpact {
    #[serde(rename = "retainedRecordCount")]
    pub retained_record_count: i64,
    #[serde(rename = "affectedWorkspaces")]
    pub affected_workspaces: Vec<AffectedWorkspace>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthData {
    pub token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    /// Server-signed ES256 grant the client verifies locally to restore an offline session
    /// (issue #18). `None` when the server has no signing key configured.
    #[serde(rename = "offlineGrant", skip_serializing_if = "Option::is_none")]
    pub offline_grant: Option<String>,
    pub user: UserDto,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceCreateRequest {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceMemberDto {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub role: String,
    #[serde(rename = "fullName", skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceDto {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    pub members: Vec<WorkspaceMemberDto>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SyncPushRequest {
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub ops: Vec<SyncOpIn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOpIn {
    #[serde(rename = "opId")]
    pub op_id: String,
    pub entity: String,
    pub operation: String,
    #[serde(rename = "baseUpdatedAt")]
    pub base_updated_at: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOpResult {
    #[serde(rename = "opId")]
    pub op_id: String,
    pub status: String,
    #[serde(rename = "resultId")]
    pub result_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictData {
    #[serde(rename = "serverDoc")]
    pub server_doc: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChange {
    pub entity: String,
    pub doc: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncTombstone {
    pub entity: String,
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapSnapshot {
    pub checkpoint: String,
    pub accounts: Vec<Value>,
    pub transactions: Vec<Value>,
    pub categories: Vec<Value>,
    pub budgets: Vec<Value>,
    #[serde(rename = "savingsGoals")]
    pub savings_goals: Vec<Value>,
    pub tags: Vec<Value>,
    #[serde(rename = "recurringRules")]
    pub recurring_rules: Vec<Value>,
    #[serde(rename = "categorizationRules")]
    pub categorization_rules: Vec<Value>,
    #[serde(rename = "savingsGoalContributions")]
    pub savings_goal_contributions: Vec<Value>,
    #[serde(rename = "transactionTemplates")]
    pub transaction_templates: Vec<Value>,
    #[serde(rename = "envelopeAssignments", default)]
    pub envelope_assignments: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullPage {
    pub changes: Vec<SyncChange>,
    pub tombstones: Vec<SyncTombstone>,
    pub checkpoint: String,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResponse {
    pub results: Vec<SyncOpResult>,
    pub checkpoint: String,
}
