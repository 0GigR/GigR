import { describe, expect, it } from 'vitest'
import {
  KNOWN_GOOD_SUI_OBJECT_ID,
  ownerKindLabel,
  proofAvailability,
  proofBadge,
  proofFields,
  proofUnavailableNotice,
} from './chainProof'
import { type MemoryVerification } from './agentMemory'

function verification(overrides: Partial<MemoryVerification> = {}): MemoryVerification {
  return {
    reference: KNOWN_GOOD_SUI_OBJECT_ID,
    available: true,
    checked: true,
    verified: false,
    reason: 'object_not_found',
    ...overrides,
  }
}

describe('KNOWN_GOOD_SUI_OBJECT_ID', () => {
  it('is the 32-byte Sui object id the panel prefills', () => {
    expect(KNOWN_GOOD_SUI_OBJECT_ID).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('proofAvailability', () => {
  it('distinguishes a flag that is off from a deployment without credentials', () => {
    expect(proofAvailability('feature_disabled')).toBe('feature_disabled')
    expect(proofAvailability('tatum_not_configured')).toBe('not_configured')
  })

  it('treats every other reason as a deployment that can still check', () => {
    expect(proofAvailability('object_not_found')).toBe('enabled')
    expect(proofAvailability('grpc_timeout')).toBe('enabled')
    expect(proofAvailability('not_a_walrus_blob')).toBe('enabled')
  })
})

describe('proofUnavailableNotice', () => {
  it('explains a disabled flag without blaming the data', () => {
    const notice = proofUnavailableNotice('feature_disabled')
    expect(notice?.title).toBe('Verification is not enabled on this deployment')
    expect(notice?.body).toContain('Walrus Memory itself is not affected')
  })

  it('explains missing credentials as a deployment problem, not a flag', () => {
    const notice = proofUnavailableNotice('tatum_not_configured')
    expect(notice?.title).toBe('Verification is not configured on this deployment')
    expect(notice?.body).toContain('no Tatum Sui credentials')
  })

  it('has no notice when the deployment can check, so the form stays', () => {
    expect(proofUnavailableNotice('object_not_found')).toBeNull()
    expect(proofUnavailableNotice('certified_blob')).toBeNull()
  })
})

describe('ownerKindLabel', () => {
  it('capitalizes the gateway word without changing it', () => {
    expect(ownerKindLabel('address')).toBe('Address')
    expect(ownerKindLabel('shared')).toBe('Shared')
    expect(ownerKindLabel('immutable')).toBe('Immutable')
  })

  it('reports an unset kind as unknown instead of guessing one', () => {
    expect(ownerKindLabel(null)).toBe('Unknown')
    expect(ownerKindLabel(undefined)).toBe('Unknown')
    expect(ownerKindLabel('   ')).toBe('Unknown')
  })
})

describe('proofFields', () => {
  it('prints identity and certification facts in a fixed order', () => {
    const fields = proofFields(
      verification({
        verified: true,
        reason: 'certified_blob',
        object_type: '0xfdc8::blob::Blob',
        object_version: 810023862,
        owner_kind: 'address',
        certified_epoch: 25,
        end_epoch: 30,
        deletable: false,
      }),
    )

    expect(fields.map((field) => field.label)).toEqual([
      'Object type',
      'Version',
      'Owner kind',
      'Certified epoch',
      'Storage end epoch',
      'Deletable',
    ])
    expect(fields[0]).toMatchObject({ value: '0xfdc8::blob::Blob', mono: true, wide: true })
    expect(fields[1]).toMatchObject({ value: '810023862', mono: true })
    expect(fields[2].value).toBe('Address')
    expect(fields[3].value).toBe('25')
    expect(fields[5].value).toBe('No')
  })

  it('omits facts the server did not return instead of printing blanks', () => {
    const fields = proofFields(
      verification({
        reason: 'not_a_walrus_blob',
        object_type: '0x2::coin::Coin',
        object_version: 4,
        owner_kind: 'shared',
        certified_epoch: null,
      }),
    )
    expect(fields.map((field) => field.label)).toEqual(['Object type', 'Version', 'Owner kind'])
  })

  it('returns nothing for an answer with no fields at all', () => {
    expect(proofFields(verification())).toEqual([])
  })

  it('never prints a certified epoch on an answer that did not verify', () => {
    // A malformed or contradictory body must not put "Certified epoch 25" next
    // to an unavailable badge.
    const fields = proofFields(
      verification({
        verified: false,
        reason: 'verification_unavailable',
        object_type: '0x2::blob::Blob',
        object_version: 1,
        owner_kind: 'address',
        certified_epoch: 25,
        end_epoch: 30,
      }),
    )
    expect(fields.map((field) => field.label)).toEqual(['Object type', 'Version', 'Owner kind'])
  })

  it('omits a certification row when a verified answer carried no epoch', () => {
    // The backend always sends an epoch for a certified blob, but a null must
    // not become the printable string "null" under the badge.
    const fields = proofFields(
      verification({
        verified: true,
        reason: 'certified_blob',
        object_type: '0x2::blob::Blob',
        certified_epoch: null,
      }),
    )
    expect(fields.map((field) => field.label)).toEqual(['Object type'])
  })
})

describe('proofBadge', () => {
  it('says verified only for the verified tone', () => {
    const result = verification({ verified: true, reason: 'certified_blob', certified_epoch: 25 })
    expect(proofBadge(result)).toEqual({
      tone: 'verified',
      label: 'Verified on Sui',
    })
  })

  it('never says verified when the tone is a negative or unavailable answer', () => {
    // A body can claim verified true while unavailable; the tone is the gate.
    const liar = verification({ available: false, checked: false, verified: true, reason: 'feature_disabled' })
    expect(proofBadge(liar).label).toBe('Unavailable')
    expect(proofBadge(verification({ reason: 'not_a_walrus_blob' })).label).toBe('Not verified')
  })
})
