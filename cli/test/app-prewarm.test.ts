import { expect, test } from 'bun:test'
import { describePrewarmRegion } from '../src/app/prewarm'

const base = { region: 'na', placement: 'remote-CMH', revision: '7', cached: 0, skipped: null, error: null }

test('describes what the prewarm did in each region', () => {
  expect(describePrewarmRegion({ ...base, cached: 3 })).toBe('warmed 3 documents')
  expect(describePrewarmRegion({ ...base, cached: 1 })).toBe('warmed 1 document')
  expect(describePrewarmRegion(base)).toBe('already warm')
  expect(describePrewarmRegion({ ...base, skipped: 'disabled' })).toBe('skipped (KV reads off in this region)')
  expect(describePrewarmRegion({ ...base, skipped: 'unpublished' })).toBe('skipped (unpublished)')
  expect(describePrewarmRegion({ ...base, cached: 2, error: 'http_error' })).toBe('failed: http_error')
  expect(describePrewarmRegion({ ...base, cached: 1, placement: null })).toBe('warmed 1 document (not confirmed in the region\'s pinned data center)')
  expect(describePrewarmRegion({ ...base, cached: 1, placement: 'local-LHR' })).toBe('warmed 1 document (not confirmed in the region\'s pinned data center)')
  expect(describePrewarmRegion({ ...base, cached: 1, placement: 'local-LHR', pinned: true })).toBe('warmed 1 document')
})
