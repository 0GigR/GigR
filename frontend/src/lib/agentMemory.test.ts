import { describe, it, expect } from 'vitest'
import {
  asFactCategory,
  failedVerification,
  findSuiReference,
  formatMemoryValue,
  groupFactsByCategory,
  groupMemory,
  humanizeMemoryKey,
  normalizeVerification,
  verificationLabel,
  verificationReasonText,
  verificationTone,
  type FactEntry,
  type MemoryVerification,
} from './agentMemory'

const OBJECT_ID = `0x${'a'.repeat(64)}`

function verification(overrides: Partial<MemoryVerification> = {}): MemoryVerification {
  return {
    reference: OBJECT_ID,
    available: true,
    checked: true,
    verified: false,
    reason: 'object_not_found',
    ...overrides,
  }
}

describe('humanizeMemoryKey', () => {
  it('uses the known label for keys the agent writes', () => {
    expect(humanizeMemoryKey('location_name')).toBe('Preferred location')
    expect(humanizeMemoryKey('usual_price_job')).toBe('Typical job budget')
    expect(humanizeMemoryKey('preferred_categories')).toBe('Preferred categories')
    expect(humanizeMemoryKey('last_search')).toBe('Last search')
  })

  it('turns an unknown key into a readable label without losing its words', () => {
    expect(humanizeMemoryKey('favorite_color')).toBe('Favorite color')
    expect(humanizeMemoryKey('preferredCategories')).toBe('Preferred Categories')
    expect(humanizeMemoryKey('USD_budget')).toBe('USD budget')
  })
})

describe('groupMemory', () => {
  it('places known keys in their groups and keeps unknown keys visible', () => {
    const groups = groupMemory({
      location_name: 'Lagos',
      preferred_categories: ['Plumbing'],
      usual_price_job: 5000,
      last_search: 'plumber',
      sui_object: OBJECT_ID,
      favourite_colour: 'blue',
    })

    expect(groups.map((group) => group.id)).toEqual([
      'location',
      'preferences',
      'budgets',
      'activity',
      'chain',
      'other',
    ])
    expect(groups.flatMap((group) => group.entries)).toHaveLength(6)
    expect(groups[5].entries[0].key).toBe('favourite_colour')
  })

  it('returns no groups for an empty memory', () => {
    expect(groupMemory({})).toEqual([])
  })
})

describe('formatMemoryValue', () => {
  it('marks null, empty, and empty containers as empty', () => {
    expect(formatMemoryValue(null)).toEqual({ kind: 'empty', text: 'Not set' })
    expect(formatMemoryValue(undefined)).toEqual({ kind: 'empty', text: 'Not set' })
    expect(formatMemoryValue('')).toEqual({ kind: 'empty', text: 'Not set' })
    expect(formatMemoryValue([])).toEqual({ kind: 'empty', text: 'No items' })
    expect(formatMemoryValue({})).toEqual({ kind: 'empty', text: 'Not set' })
  })

  it('keeps scalar values as text, including zero and false', () => {
    expect(formatMemoryValue(0)).toEqual({ kind: 'text', text: '0' })
    expect(formatMemoryValue(false)).toEqual({ kind: 'text', text: 'false' })
    expect(formatMemoryValue('line one\nline two')).toEqual({
      kind: 'text',
      text: 'line one\nline two',
    })
  })

  it('renders a list of primitives as chips and anything nested as JSON', () => {
    expect(formatMemoryValue(['a', 'b'])).toEqual({ kind: 'list', items: ['a', 'b'] })
    const nested = formatMemoryValue([{ id: 1 }])
    expect(nested.kind).toBe('json')
    expect(formatMemoryValue({ id: 1 }).kind).toBe('json')
  })
})

describe('findSuiReference', () => {
  it('finds a direct object id, with or without a prefix', () => {
    expect(findSuiReference(OBJECT_ID)).toBe(OBJECT_ID)
    expect(findSuiReference(`sui:${OBJECT_ID}`)).toBe(OBJECT_ID)
    expect(findSuiReference(`object: ${OBJECT_ID}`)).toBe(OBJECT_ID)
  })

  it('finds one id inside a structured value', () => {
    expect(findSuiReference({ blob: OBJECT_ID, label: 'receipt' })).toBe(OBJECT_ID)
  })

  it('refuses to guess when there is no id or more than one', () => {
    expect(findSuiReference('no reference here')).toBeNull()
    expect(findSuiReference(`0xabc and 0xdef`)).toBeNull()
    expect(findSuiReference(`0x${'a'.repeat(65)}`)).toBeNull()
  })
})

describe('normalizeVerification', () => {
  it('never reports verified for a malformed body', () => {
    const result = normalizeVerification({}, OBJECT_ID)
    expect(result.verified).toBe(false)
    expect(result.available).toBe(false)
    expect(verificationTone(result)).toBe('unavailable')
  })

  it('does not claim verification when the server says verified is false', () => {
    const result = normalizeVerification(
      { reference: OBJECT_ID, available: true, checked: true, verified: false, reason: 'not_a_walrus_blob' },
      OBJECT_ID,
    )
    expect(result.verified).toBe(false)
    expect(verificationTone(result)).toBe('unverified')
  })

  it('treats verified true as unverified when the check was not available', () => {
    const result = normalizeVerification(
      { reference: OBJECT_ID, available: false, checked: false, verified: true, reason: 'feature_disabled' },
      OBJECT_ID,
    )
    expect(verificationTone(result)).toBe('unavailable')
  })
})

describe('verificationTone', () => {
  it('reports a certified blob as verified', () => {
    expect(
      verificationTone(
        verification({ verified: true, reason: 'certified_blob', certified_epoch: 12 }),
      ),
    ).toBe('verified')
    expect(verificationLabel('verified')).toBe('Verified')
  })

  it('reports a checked negative answer as not verified', () => {
    expect(verificationTone(verification({ reason: 'object_not_found' }))).toBe('unverified')
    expect(verificationTone(verification({ reason: 'blob_not_certified' }))).toBe('unverified')
    expect(verificationLabel('unverified')).toBe('Not verified')
  })

  it('reports feature-off, unreachable and unresolved checks as unavailable', () => {
    expect(
      verificationTone(
        verification({ available: false, checked: false, reason: 'feature_disabled' }),
      ),
    ).toBe('unavailable')
    expect(verificationTone(verification({ reason: 'verification_unavailable' }))).toBe(
      'unavailable',
    )
    expect(verificationTone(verification({ reason: 'rpc_error' }))).toBe('unavailable')
    expect(
      verificationTone(
        verification({ checked: false, reason: 'blob_id_not_resolvable_without_indexer' }),
      ),
    ).toBe('unavailable')
  })

  it('treats a failed request as unavailable', () => {
    expect(verificationTone(failedVerification(OBJECT_ID))).toBe('unavailable')
  })
})

describe('verificationReasonText', () => {
  it('explains a disabled feature in plain language', () => {
    const text = verificationReasonText(
      verification({ available: false, checked: false, reason: 'feature_disabled' }),
    )
    expect(text).toBe('Sui verification is turned off in this environment.')
  })

  it('explains a missing object without claiming a verification', () => {
    const text = verificationReasonText(verification({ reason: 'object_not_found' }))
    expect(text).toContain('No Sui object with this id was found')
  })

  it('includes the certification epoch when verified', () => {
    const text = verificationReasonText(
      verification({ verified: true, reason: 'certified_blob', certified_epoch: 12 }),
    )
    expect(text).toBe('Certified Walrus blob on Sui in epoch 12.')
  })

  it('does not echo a certified reason when the answer is not verified', () => {
    const text = verificationReasonText(verification({ verified: false, reason: 'certified_blob' }))
    expect(text).toBe('The check did not confirm this reference.')
  })
})

describe('groupFactsByCategory', () => {
  const facts: FactEntry[] = [
    { text: 'Bola Ade has messaged about Fix sink.', category: 'messages' },
    { text: 'Bola Ade is based in Ihiagwa.', category: 'about' },
    { text: 'Bola Ade has messaged about Move furniture.', category: 'messages' },
  ]

  it('groups in the page order and keeps the server order inside a group', () => {
    const groups = groupFactsByCategory(facts)

    expect(groups.map((group) => group.id)).toEqual(['about', 'messages'])
    expect(groups[0].label).toBe('About you')
    expect(groups[1].label).toBe('Messages and activity')
    expect(groups[1].entries.map((entry) => entry.text)).toEqual([
      'Bola Ade has messaged about Fix sink.',
      'Bola Ade has messaged about Move furniture.',
    ])
  })

  it('omits an empty category instead of rendering a heading with no rows', () => {
    expect(groupFactsByCategory([])).toEqual([])
    expect(groupFactsByCategory(facts).some((group) => group.id === 'jobs')).toBe(false)
  })

  it('coerces an unknown or missing category to other rather than dropping the fact', () => {
    expect(asFactCategory('jobs')).toBe('jobs')
    expect(asFactCategory('unknown')).toBe('other')
    expect(asFactCategory(undefined)).toBe('other')
    expect(asFactCategory('toString')).toBe('other')
  })
})
