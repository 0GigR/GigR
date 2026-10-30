/**
 * providerPicker.test.ts - the provider list and the keyboard rules behind it.
 *
 * The combobox has no DOM test because the project's test environment is Node
 * only. That is why the union of work lives here: parsing, filtering and the
 * wrap-around are the parts that can be wrong, and each test below fails on the
 * change it is guarding against rather than on a rendered class name.
 */

import { describe, expect, it } from 'vitest'

import {
  filterProviders,
  moveActiveIndex,
  parseBriefProviders,
  providerCategoryLabel,
  providerMetaLabel,
  providerRatingLabel,
  type BriefProvider,
} from './providerPicker'

const PROVIDER: BriefProvider = {
  providerId: 'da15e7cb-2103-4d71-904b-2c6cb7616f66',
  name: 'OKAFOR KOSISOCHUKWU',
  category: 'Home Services',
  ratingCount: 3,
  ratingAverage: 4,
  completedJobs: 3,
  jobId: 'ff099832-29a6-48ad-9d42-02bbdd016010',
  jobTitle: 'Traditional Private Chef',
}

const OTHER: BriefProvider = {
  ...PROVIDER,
  providerId: 'db9f9c42-b7fa-4d61-b5ff-9b71ec3fe31c',
  name: 'Orji John',
  category: 'Digital-Tech Services',
  jobId: '8611db23-84e4-4660-a070-ed008f11f37a',
  jobTitle: 'Average Joe Web Dev',
}

const ROW = {
  provider_id: PROVIDER.providerId,
  name: 'OKAFOR KOSISOCHUKWU',
  category: 'Home Services',
  rating_count: 3,
  rating_average: 4,
  completed_jobs: 3,
  job_id: PROVIDER.jobId,
  job_title: 'Traditional Private Chef',
  job_price: 5000,
}

describe('parseBriefProviders', () => {
  it('reads the fields the picker shows from the endpoint body', () => {
    const providers = parseBriefProviders({ providers: [ROW] })

    expect(providers).toEqual([PROVIDER])
  })

  it('drops a row whose job id is not a job id, because that row cannot be bought', () => {
    const providers = parseBriefProviders({
      providers: [ROW, { ...ROW, provider_id: 'x', job_id: 'not-a-uuid' }],
    })

    expect(providers.map((provider) => provider.providerId)).toEqual([
      PROVIDER.providerId,
    ])
  })

  it('keeps one row per provider when the endpoint repeats one', () => {
    const providers = parseBriefProviders({ providers: [ROW, { ...ROW }] })

    expect(providers).toHaveLength(1)
  })

  it('reads a body that is not the documented shape as no providers at all', () => {
    expect(parseBriefProviders(null)).toEqual([])
    expect(parseBriefProviders({ providers: 'nope' })).toEqual([])
    expect(parseBriefProviders([ROW])).toEqual([])
  })

  it('names a blank job title instead of rendering an empty line', () => {
    const providers = parseBriefProviders({
      providers: [{ ...ROW, job_title: '   ' }],
    })

    expect(providers[0].jobTitle).toBe('Untitled job')
  })
})

describe('filterProviders', () => {
  it('lists every provider while the field is empty', () => {
    expect(filterProviders([PROVIDER, OTHER], '   ')).toEqual([PROVIDER, OTHER])
  })

  it('matches part of a provider name whatever the case', () => {
    expect(filterProviders([PROVIDER, OTHER], 'orJi')).toEqual([OTHER])
  })

  it('matches the category as well as the name', () => {
    expect(filterProviders([PROVIDER, OTHER], 'home')).toEqual([PROVIDER])
  })

  it('returns nothing when no provider matches', () => {
    expect(filterProviders([PROVIDER, OTHER], 'plumber')).toEqual([])
  })
})

describe('moveActiveIndex', () => {
  it('wraps down from the last row to the first', () => {
    expect(moveActiveIndex(1, 1, 2)).toBe(0)
  })

  it('wraps up from the first row to the last', () => {
    expect(moveActiveIndex(0, -1, 2)).toBe(1)
  })

  it('enters at the top going down and at the bottom going up', () => {
    expect(moveActiveIndex(-1, 1, 3)).toBe(0)
    expect(moveActiveIndex(-1, -1, 3)).toBe(2)
  })

  it('has no row to highlight when the list is empty', () => {
    expect(moveActiveIndex(0, 1, 0)).toBe(-1)
  })
})

describe('provider labels', () => {
  it('states the rating and how many ratings it came from', () => {
    expect(providerRatingLabel(PROVIDER)).toBe('4.00 from 3 ratings')
  })

  it('uses the singular for one rating', () => {
    expect(providerRatingLabel({ ...PROVIDER, ratingCount: 1 })).toBe(
      '4.00 from 1 rating',
    )
  })

  it('says a provider has no ratings rather than showing a dash', () => {
    expect(providerRatingLabel({ ...PROVIDER, ratingCount: 0, ratingAverage: null })).toBe(
      'No ratings yet',
    )
  })

  it('says a provider has no category rather than showing an empty line', () => {
    expect(providerCategoryLabel({ ...PROVIDER, category: null })).toBe(
      'No category recorded',
    )
  })

  it('puts the category and the rating on the line under the name', () => {
    expect(providerMetaLabel(PROVIDER)).toBe('Home Services - 4.00 from 3 ratings')
  })
})
