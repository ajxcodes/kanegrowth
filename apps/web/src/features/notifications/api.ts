import axiosInstance from '@lib/axiosInstance'
import { API_PATHS } from '@lib/apiPaths'
import type { ApiResponse, NotificationPreferences } from '@lib/types/api'
import { unwrapApiData } from '@lib/apiHelpers'
import { isStandaloneLocalEnabled } from '@lib/standaloneLocalFlag'
import type { NotificationListPayload, NotificationType } from './types'

/** Server representation of one notification-centre row. */
export const fetchNotifications = async (): Promise<NotificationListPayload> => {
    const response = await axiosInstance.get<ApiResponse<NotificationListPayload>>(
        API_PATHS.NOTIFICATIONS.GET_ALL
    )
    return unwrapApiData(response)
}

export const markNotificationRead = async (notificationId: string): Promise<void> => {
    await axiosInstance.patch(API_PATHS.NOTIFICATIONS.MARK_READ(notificationId))
}

export const dismissNotification = async (notificationId: string): Promise<void> => {
    await axiosInstance.patch(API_PATHS.NOTIFICATIONS.DISMISS(notificationId))
}

export const markAllNotificationsRead = async (): Promise<void> => {
    await axiosInstance.patch(API_PATHS.NOTIFICATIONS.MARK_ALL_READ)
}

export const fetchNotificationPreferences = async (): Promise<NotificationPreferences> => {
    const response = await axiosInstance.get<ApiResponse<NotificationPreferences>>(
        API_PATHS.NOTIFICATIONS.PREFERENCES
    )
    return unwrapApiData(response)
}

/**
 * Persists only the keys supplied and returns the server's complete, normalised preferences
 * object (defaults filled in, values clamped).
 */
export const updateNotificationPreferences = async (
    patch: Partial<NotificationPreferences>
): Promise<NotificationPreferences> => {
    const response = await axiosInstance.patch<ApiResponse<NotificationPreferences>>(
        API_PATHS.NOTIFICATIONS.PREFERENCES,
        patch
    )
    return unwrapApiData(response)
}

export interface NotificationEventInput {
    type: NotificationType
    title?: string
    message?: string
    referenceType?: string
    referenceId?: string
    metadata?: Record<string, unknown>
    dedupeKey?: string
    workspaceId?: string | null
}

/**
 * Fire-and-forget event ingress for producers that run in the client (imports are local-first).
 * A delivery failure must never change the caller's result, so the error is swallowed.
 */
export const emitNotificationEvent = async (event: NotificationEventInput): Promise<void> => {
    if (isStandaloneLocalEnabled()) return
    try {
        await axiosInstance.post(API_PATHS.NOTIFICATIONS.EVENTS, event)
    } catch {
        /* best effort: the notification centre is not part of the producer's contract */
    }
}
