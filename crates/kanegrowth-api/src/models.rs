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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserDto {
    pub id: String,
    pub email: String,
    #[serde(rename = "fullName")]
    pub full_name: Option<String>,
    #[serde(rename = "emailVerified")]
    pub email_verified: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    #[serde(rename = "fullName")]
    pub full_name: Option<String>,
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
    pub user: UserDto,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceCreateRequest {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "ownerUserId")]
    pub owner_user_id: String,
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
