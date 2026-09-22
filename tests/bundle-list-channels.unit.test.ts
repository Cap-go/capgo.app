import { describe, expect, it } from 'vitest'
import { formatBundleListChannels, mergeBundleListChannels } from '../src/services/bundleLinkedChannels'

describe('bundle list channel labels', () => {
  it('dedupes and sorts by name', () => {
    expect(mergeBundleListChannels([
      { id: 2, name: 'production' },
      { id: 1, name: 'development' },
      { id: 2, name: 'production' },
    ])).toEqual([
      { id: 1, name: 'development' },
      { id: 2, name: 'production' },
    ])
  })

  it('joins one or two channel names', () => {
    expect(formatBundleListChannels([{ id: 1, name: 'production' }])).toEqual({
      label: 'production',
      title: 'production',
    })
    expect(formatBundleListChannels([
      { id: 2, name: 'production' },
      { id: 1, name: 'development' },
    ])).toEqual({
      label: 'development, production',
      title: 'development, production',
    })
  })

  it('compacts three or more channels with hover title', () => {
    expect(formatBundleListChannels([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
      { id: 3, name: 'gamma' },
    ])).toEqual({
      label: 'alpha +2',
      title: 'alpha, beta, gamma',
    })
  })
})
