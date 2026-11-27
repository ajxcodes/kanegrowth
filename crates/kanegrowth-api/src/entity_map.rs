pub const ENTITY_TABLES: &[(&str, &str)] = &[
    ("account", "accounts"),
    ("transaction", "transactions"),
    ("category", "categories"),
    ("budget", "budgets"),
    ("savingsGoal", "savingsGoals"),
    ("tag", "tags"),
    ("recurringRule", "recurringRules"),
    ("categorizationRule", "categorizationRules"),
    ("savingsGoalContribution", "savingsGoalContributions"),
    ("transactionTemplate", "transactionTemplates"),
    ("envelopeAssignment", "envelopeAssignments"),
];

pub fn table_for_entity(entity: &str) -> Option<&'static str> {
    ENTITY_TABLES
        .iter()
        .find(|(e, _)| *e == entity)
        .map(|(_, t)| *t)
}

pub fn entity_for_table(table: &str) -> Option<&'static str> {
    ENTITY_TABLES
        .iter()
        .find(|(_, t)| *t == table)
        .map(|(e, _)| *e)
}

pub fn is_personal_entity(entity: &str) -> bool {
    matches!(
        entity,
        "category"
            | "tag"
            | "categorizationRule"
            | "savingsGoalContribution"
            | "transactionTemplate"
    )
}

#[allow(dead_code)]
pub fn all_entities() -> &'static [&'static str] {
    &[
        "account",
        "transaction",
        "category",
        "budget",
        "savingsGoal",
        "tag",
        "recurringRule",
        "categorizationRule",
        "savingsGoalContribution",
        "transactionTemplate",
        "envelopeAssignment",
    ]
}

pub fn all_tables() -> &'static [&'static str] {
    &[
        "accounts",
        "transactions",
        "categories",
        "budgets",
        "savingsGoals",
        "tags",
        "recurringRules",
        "categorizationRules",
        "savingsGoalContributions",
        "transactionTemplates",
        "envelopeAssignments",
    ]
}

pub fn promoted_columns(table: &str) -> &'static [&'static str] {
    match table {
        "accounts" => &[
            "userId",
            "workspaceId",
            "name",
            "type",
            "currency",
            "currentBalance",
            "isArchived",
            "accountGroup",
            "isLiability",
            "interestRateBps",
            "minimumPaymentMinor",
        ],
        "transactions" => &[
            "userId",
            "workspaceId",
            "accountId",
            "categoryId",
            "type",
            "status",
            "amount",
            "date",
            "clearedStatus",
            "memberId",
            "isShared",
            "transferPairId",
            "hasSplitChildren",
            "splitTransactionId",
            "tagsJson",
        ],
        "categories" => &[
            "userId",
            "masterCategoryId",
            "name",
            "isArchived",
            "envelopeType",
            "monthlyTargetMinor",
        ],
        "budgets" => &[
            "userId",
            "workspaceId",
            "categoryId",
            "periodStart",
            "periodEnd",
            "isArchived",
        ],
        "savingsGoals" => &["userId", "workspaceId", "accountId", "status"],
        "tags" => &["userId", "name"],
        "recurringRules" => &[
            "userId",
            "workspaceId",
            "accountId",
            "categoryId",
            "nextDueDate",
            "isActive",
            "isArchived",
        ],
        "categorizationRules" => &["userId", "categoryId", "accountId", "priority", "isActive"],
        "savingsGoalContributions" => &["userId", "goalId", "amount", "contributedAt"],
        "transactionTemplates" => &["userId", "name"],
        "envelopeAssignments" => &[
            "userId",
            "workspaceId",
            "kind",
            "envelopeId",
            "month",
            "amountMinor",
        ],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entity_table_roundtrip() {
        assert_eq!(table_for_entity("account"), Some("accounts"));
        assert_eq!(entity_for_table("accounts"), Some("account"));
        assert_eq!(all_tables().len(), 11);
        assert!(promoted_columns("accounts").contains(&"currentBalance"));
    }
    #[test]
    fn personal_entities() {
        assert!(is_personal_entity("category"));
        assert!(!is_personal_entity("account"));
    }
}
