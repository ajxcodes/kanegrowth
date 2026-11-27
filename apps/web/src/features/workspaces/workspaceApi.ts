import axiosInstance from '@lib/axiosInstance'
import { API_PATHS } from '@lib/apiPaths'
import type { ApiResponse } from '@lib/types/api'
import type { Workspace, WorkspaceInvite, WorkspaceInviteFormData, WorkspaceInviteRole, WorkspaceMember, WorkspaceRole } from '@features/workspaces/types'
import { unwrapApiData } from '@lib/apiHelpers'

const WORKSPACE_ROLES: WorkspaceRole[] = ['owner', 'editor', 'viewer']

const toRole = (role: unknown): WorkspaceRole =>
    WORKSPACE_ROLES.includes(role as WorkspaceRole) ? (role as WorkspaceRole) : 'viewer'

const toMember = (raw: unknown): WorkspaceMember | null => {
    if (!raw || typeof raw !== 'object') return null
    const wire = raw as Partial<WorkspaceMember> & { userId?: string }
    if (!wire.userId) return null
    return {
        userId: wire.userId,
        role: toRole(wire.role),
        fullName: wire.fullName,
        email: wire.email,
    }
}

/**
 * Normalises the workspace wire shape at the trust boundary: the canonical API emits
 * `_id` / `ownerId` / `members`, while an older deployment emits `id` / `ownerUserId` and no
 * members. `WorkspacesPage` dereferences `members.length`, so `members` is never absent here.
 */
const toWorkspace = (raw: unknown): Workspace => {
    const wire = (raw ?? {}) as Partial<Workspace> & { id?: string; ownerUserId?: string }
    const members = Array.isArray(wire.members)
        ? wire.members.map(toMember).filter((member): member is WorkspaceMember => member !== null)
        : []
    return {
        _id: wire._id ?? wire.id ?? '',
        name: wire.name ?? '',
        ownerId: wire.ownerId ?? wire.ownerUserId ?? '',
        members,
        createdAt: wire.createdAt,
        updatedAt: wire.updatedAt,
    }
}

export const fetchWorkspaces = async (): Promise<Workspace[]> => {
    const response = await axiosInstance.get<ApiResponse<Workspace[]>>(API_PATHS.WORKSPACES.GET_ALL)
    return unwrapApiData(response).map(toWorkspace)
}

export const fetchWorkspaceById = async (workspaceId: string): Promise<Workspace> => {
    const response = await axiosInstance.get<ApiResponse<Workspace>>(
        API_PATHS.WORKSPACES.GET_BY_ID(workspaceId)
    )
    return toWorkspace(unwrapApiData(response))
}

export const createWorkspace = async (name: string): Promise<Workspace> => {
    const response = await axiosInstance.post<ApiResponse<Workspace>>(API_PATHS.WORKSPACES.CREATE, {
        name,
    })
    return toWorkspace(unwrapApiData(response))
}

export const updateWorkspace = async (workspaceId: string, name: string): Promise<Workspace> => {
    const response = await axiosInstance.patch<ApiResponse<Workspace>>(
        API_PATHS.WORKSPACES.UPDATE(workspaceId),
        { name }
    )
    return toWorkspace(unwrapApiData(response))
}

export const inviteWorkspaceMember = async (
    workspaceId: string,
    payload: WorkspaceInviteFormData
): Promise<WorkspaceInvite> => {
    const response = await axiosInstance.post<ApiResponse<WorkspaceInvite>>(
        API_PATHS.WORKSPACES.INVITE(workspaceId),
        payload
    )
    return unwrapApiData(response)
}

export const fetchReceivedInvites = async (): Promise<WorkspaceInvite[]> => {
    const response = await axiosInstance.get<ApiResponse<WorkspaceInvite[]>>(
        API_PATHS.WORKSPACES.RECEIVED_INVITES
    )
    return unwrapApiData(response)
}

export const fetchWorkspacePendingInvites = async (
    workspaceId: string
): Promise<WorkspaceInvite[]> => {
    const response = await axiosInstance.get<ApiResponse<WorkspaceInvite[]>>(
        API_PATHS.WORKSPACES.PENDING_INVITES(workspaceId)
    )
    return unwrapApiData(response)
}

export const acceptWorkspaceInvite = async (inviteId: string): Promise<Workspace> => {
    const response = await axiosInstance.post<ApiResponse<Workspace>>(
        API_PATHS.WORKSPACES.ACCEPT_INVITE(inviteId)
    )
    return toWorkspace(unwrapApiData(response))
}

export const declineWorkspaceInvite = async (inviteId: string): Promise<void> => {
    await axiosInstance.post(API_PATHS.WORKSPACES.DECLINE_INVITE(inviteId))
}

export const updateWorkspaceMemberRole = async (
    workspaceId: string,
    memberUserId: string,
    role: WorkspaceInviteRole
): Promise<Workspace> => {
    const response = await axiosInstance.patch<ApiResponse<Workspace>>(
        API_PATHS.WORKSPACES.UPDATE_MEMBER(workspaceId, memberUserId),
        { role }
    )
    return toWorkspace(unwrapApiData(response))
}

export const removeWorkspaceMember = async (
    workspaceId: string,
    memberUserId: string
): Promise<Workspace> => {
    const response = await axiosInstance.delete<ApiResponse<Workspace>>(
        API_PATHS.WORKSPACES.REMOVE_MEMBER(workspaceId, memberUserId)
    )
    return toWorkspace(unwrapApiData(response))
}
