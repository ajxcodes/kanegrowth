import { describe, expect, it } from 'vitest'
import fixture from '@fixtures/contract/auth.json'
import type { AuthPayload } from '@features/auth/types'
import { parseAuthPayload } from '../parseAuthPayload'

describe('auth contract', () => {
    it('parses the shared auth fixture into a non-empty _id and rejects an id-less payload', () => {
        const payload = parseAuthPayload(fixture.auth)
        expect(payload.user._id).toBe('11111111-1111-4111-8111-111111111111')

        const legacy = parseAuthPayload({
            token: 'legacy-token',
            user: { id: 'legacy-id' },
        } as unknown as AuthPayload)
        expect(legacy.user._id).toBe('legacy-id')

        expect(() =>
            parseAuthPayload({ token: 't', user: { email: 'x@y.z' } } as unknown as AuthPayload)
        ).toThrow('Invalid auth response from server')
    })

    it('preserves the offline grant from the shared auth fixture', () => {
        expect(parseAuthPayload(fixture.auth).offlineGrant).toBe('contract-offline-grant')
    })
})
