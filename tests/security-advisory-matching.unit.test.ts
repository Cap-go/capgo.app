import { describe, expect, it } from 'vitest'
import type { Advisory } from '../supabase/functions/shared/security_advisory.ts'
import { CAPGO_CLI_PACKAGE } from '../supabase/functions/_backend/utils/security_advisory_packages.ts'
import { matchAppPackagesToAdvisories, resolveAdvisoryStatus } from '../supabase/functions/_backend/utils/security_advisory_matching.ts'
import { satisfiesGhsaAffectedRange } from '../supabase/functions/_backend/utils/security_advisory_version.ts'
import { parse } from '@std/semver'

const exampleAdvisory: Advisory = {
  id: 'GHSA-example-0001',
  ghsa_id: 'GHSA-example-0001',
  title: 'Example',
  severity: 'high',
  affected: [
    { package: '@capacitor/core', affected_range: '>= 6.0.0, < 6.2.0', patched_version: '6.2.0' },
    { package: '@capacitor/core', affected_range: '>= 7.0.0, < 7.2.1', patched_version: '7.2.1' },
    { package: '@capgo/cli', affected_range: '< 2.0.0', patched_version: '2.0.0' },
  ],
  fix_steps: 'Upgrade',
  published_at: '2026-01-01T00:00:00.000Z',
  url: 'https://capgo.app/security/',
}

describe('satisfiesGhsaAffectedRange', () => {
  it('treats comma-separated clauses as AND', () => {
    const version = parse('6.14.2')
    expect(satisfiesGhsaAffectedRange(version, '>= 6.0.0, < 6.14.3')).toBe(true)
    expect(satisfiesGhsaAffectedRange(version, '>= 6.0.0, < 6.14.0')).toBe(false)
  })

  it('treats || as OR between intervals', () => {
    const version = parse('6.1.0')
    expect(satisfiesGhsaAffectedRange(version, '>= 7.0.0, < 7.2.1 || >= 6.0.0, < 6.2.0')).toBe(true)
    expect(satisfiesGhsaAffectedRange(version, '>= 7.0.0, < 7.1.0')).toBe(false)
  })
})

describe('resolveAdvisoryStatus', () => {
  it('marks affected versions inside the GHSA range', () => {
    expect(resolveAdvisoryStatus('6.1.0', { affected_range: '>= 6.0.0, < 6.2.0', patched_version: '6.2.0' })).toBe('affected')
  })

  it('marks patched versions at or above the fix', () => {
    expect(resolveAdvisoryStatus('6.2.0', { affected_range: '>= 6.0.0, < 6.2.0', patched_version: '6.2.0' })).toBe('patched')
    expect(resolveAdvisoryStatus('6.3.0', { affected_range: '>= 6.0.0, < 6.2.0', patched_version: '6.2.0' })).toBe('patched')
  })

  it('stays affected when patched_version is null but still in range', () => {
    expect(resolveAdvisoryStatus('6.1.0', { affected_range: '>= 6.0.0, < 6.2.0', patched_version: null })).toBe('affected')
  })

  it('never claims safe for unknown versions', () => {
    expect(resolveAdvisoryStatus('not-a-version', { affected_range: '>= 6.0.0, < 6.2.0', patched_version: '6.2.0' })).toBe('unknown')
    expect(resolveAdvisoryStatus('', { affected_range: '>= 6.0.0, < 6.2.0', patched_version: '6.2.0' })).toBe('unknown')
    expect(resolveAdvisoryStatus('6.0.0', { affected_range: '', patched_version: '6.2.0' })).toBe('unknown')
  })
})

describe('matchAppPackagesToAdvisories', () => {
  it('matches each reported package against every affected entry on its major line', () => {
    const packages = new Map([
      ['@capacitor/core', '6.1.0'],
      ['@capgo/cli', '1.9.0'],
    ])
    const items = matchAppPackagesToAdvisories(packages, [exampleAdvisory])
    const coreItems = items.filter(i => i.package === '@capacitor/core')
    expect(coreItems).toHaveLength(2)
    expect(coreItems.find(i => i.affected.patched_version === '6.2.0')?.status).toBe('affected')
    expect(coreItems.find(i => i.affected.patched_version === '7.2.1')?.status).toBe('patched')
    expect(items.find(i => i.package === '@capgo/cli')?.status).toBe('affected')
  })

  it(`marks ${CAPGO_CLI_PACKAGE} unknown when version is missing`, () => {
    const packages = new Map<string, string>([[normalizePackageKey(CAPGO_CLI_PACKAGE), '']])
    const items = matchAppPackagesToAdvisories(packages, [exampleAdvisory])
    expect(items.find(i => i.package === '@capgo/cli')?.status).toBe('unknown')
  })
})

function normalizePackageKey(name: string) {
  return name.trim().toLowerCase()
}
