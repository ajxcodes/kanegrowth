import { describe, expect, it } from 'vitest'
import { requireEnvelopeUserId } from '../hooks/useEnvelopeLedger'

describe('envelope ledger attribution guard', () => {
    it('refuses to write an envelope mutation without an authenticated user id', () => {
        expect(requireEnvelopeUserId('user-1')).toBe('user-1')
        expect(() => requireEnvelopeUserId(undefined)).toThrow('Not authenticated')
        expect(() => requireEnvelopeUserId('')).toThrow('Not authenticated')
    })
})
