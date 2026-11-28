export type NotificationType =
    | 'budget_over_limit'
    | 'budget_threshold'
    | 'bill_due'
    | 'maintenance_due'
    | 'sync_completed'
    | 'import_completed'
    | 'savings_milestone'
    | 'workspace_invite'

export type NotificationNtfyStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface NotificationItem {
    _id: string
    type: NotificationType
    title: string
    message: string
    referenceType?:
        | 'budget'
        | 'recurring_rule'
        | 'savings_goal'
        | 'import'
        | 'maintenance'
        | 'sync'
    referenceId?: string
    readAt?: string | null
    dismissedAt?: string | null
    metadata?: Record<string, unknown>
    /** Delivery state on the server; `skipped` means ntfy is not configured. */
    ntfyStatus?: NotificationNtfyStatus
    createdAt: string
}

export interface NotificationListPayload {
    notifications: NotificationItem[]
    unreadCount: number
}
