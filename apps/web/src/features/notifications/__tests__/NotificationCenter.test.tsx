import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderWithProviders, screen, waitFor, userEvent } from '@/test/test-utils'
import NotificationCenter from '../components/NotificationCenter'
import axiosInstance from '@lib/axiosInstance'
import { API_PATHS } from '@lib/apiPaths'
import type { NotificationItem, NotificationListPayload } from '../types'

vi.mock('@lib/axiosInstance', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
    },
}))

const notification = (overrides: Partial<NotificationItem>): NotificationItem => ({
    _id: 'n1',
    type: 'bill_due',
    title: 'Rent due',
    message: 'Rent is due tomorrow',
    referenceType: 'recurring_rule',
    referenceId: 'rule-1',
    readAt: null,
    dismissedAt: null,
    metadata: {},
    ntfyStatus: 'skipped',
    createdAt: new Date().toISOString(),
    ...overrides,
})

const mockList = (payload: NotificationListPayload) => {
    vi.mocked(axiosInstance.get).mockResolvedValue({ success: true, data: payload })
}

beforeEach(() => {
    vi.mocked(axiosInstance.patch).mockResolvedValue({ success: true, data: {} })
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('NotificationCenter', () => {
    it('lists unread notifications and marks one read', async () => {
        mockList({ notifications: [notification({ _id: 'n1', title: 'Rent due' })], unreadCount: 1 })
        renderWithProviders(<NotificationCenter />, { withUser: false, withWorkspace: false })

        const user = userEvent.setup()
        await user.click(await screen.findByTestId('notification-center-bell'))

        expect(await screen.findByText('Rent due')).toBeInTheDocument()
        expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent('1')

        await user.click(screen.getByTestId('notification-mark-read'))

        await waitFor(() =>
            expect(axiosInstance.patch).toHaveBeenCalledWith(API_PATHS.NOTIFICATIONS.MARK_READ('n1'))
        )
        await waitFor(() =>
            expect(screen.queryByTestId('notification-unread-badge')).not.toBeInTheDocument()
        )
        expect(screen.getByText('Rent due')).toBeInTheDocument()
    })

    it('dismisses a notification and marks all remaining read', async () => {
        mockList({
            notifications: [
                notification({ _id: 'n1', title: 'First alert' }),
                notification({ _id: 'n2', title: 'Second alert' }),
            ],
            unreadCount: 2,
        })
        renderWithProviders(<NotificationCenter />, { withUser: false, withWorkspace: false })

        const user = userEvent.setup()
        await user.click(await screen.findByTestId('notification-center-bell'))
        expect(await screen.findByText('First alert')).toBeInTheDocument()

        await user.click(screen.getAllByTestId('notification-dismiss')[0])

        await waitFor(() =>
            expect(axiosInstance.patch).toHaveBeenCalledWith(API_PATHS.NOTIFICATIONS.DISMISS('n1'))
        )
        await waitFor(() => expect(screen.queryByText('First alert')).not.toBeInTheDocument())
        expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent('1')

        await user.click(screen.getByTestId('notification-mark-all-read'))

        await waitFor(() =>
            expect(axiosInstance.patch).toHaveBeenCalledWith(API_PATHS.NOTIFICATIONS.MARK_ALL_READ)
        )
        await waitFor(() =>
            expect(screen.queryByTestId('notification-unread-badge')).not.toBeInTheDocument()
        )
    })
})
