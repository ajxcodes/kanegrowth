import type { ApiResponse, User } from '@lib/types/api'
import type { AuthPayload } from '@features/auth/types'
import { unwrapApiData } from '@lib/apiHelpers'

type WireUser = Partial<User> & { id?: string; emailVerified?: boolean }

type WirePayload = Partial<AuthPayload> & { token?: string; user?: WireUser }

/**
 * Normalises the server's auth payload at the trust boundary.
 *
 * The canonical wire shape is `_id` / `isEmailVerified`, but a deployment running an older API
 * emits `id` / `emailVerified`. Both parse here; a payload with no usable id fails closed so a
 * session can never be created that would write local rows with an empty `userId`.
 */
export const parseAuthPayload = (response: ApiResponse<AuthPayload> | AuthPayload): AuthPayload => {
    const wire = unwrapApiData(response as ApiResponse<AuthPayload>) as WirePayload
    const user = wire.user
    const id = user?._id ?? user?.id
    if (!wire.token || !user || !id) throw new Error('Invalid auth response from server')
    return {
        ...wire,
        token: wire.token,
        user: {
            ...user,
            _id: id,
            isEmailVerified: user.isEmailVerified ?? user.emailVerified,
        } as User,
    }
}
