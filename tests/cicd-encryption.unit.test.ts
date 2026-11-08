import type { CiEncryptionBundle, CiEncryptionChannel, CiProductionEncryptionEvidence } from '../src/utils/cicdEncryption'
import { describe, expect, it } from 'vitest'
import { ciChannelEncryptionBundles, ciProductionEncryptionEvidence } from '../src/utils/cicdEncryption'

const plaintext = { name: '1.0.0', key_id: null, session_key: null, deleted: false, deleted_at: null } satisfies CiEncryptionBundle
const encrypted = { ...plaintext, name: '1.0.1', key_id: 'fixture-encryption-key' } satisfies CiEncryptionBundle
const sessionOnly = { ...plaintext, session_key: 'fixture-encrypted-session-key' } satisfies CiEncryptionBundle

const cases: Array<[string, Array<CiEncryptionBundle | null>, CiProductionEncryptionEvidence]> = [
  ['no production candidates', [], 'unknown'],
  ['a readable plaintext production bundle', [plaintext], 'plaintext'],
  ['all selected targets use plaintext', [plaintext, { ...plaintext, name: '2.0.0' }], 'plaintext'],
  ['a readable encrypted production bundle', [encrypted], 'encrypted'],
  ['an encrypted session without a key identifier', [sessionOnly], 'encrypted'],
  ['an encrypted session with a blank key identifier', [{ ...sessionOnly, key_id: '   ' }], 'encrypted'],
  ['one session-encrypted target among plaintext and unreadable targets', [plaintext, null, sessionOnly], 'encrypted'],
  ['one encrypted target among plaintext targets', [plaintext, encrypted], 'encrypted'],
  ['one encrypted target among unreadable targets', [null, encrypted], 'encrypted'],
  ['one encrypted target before unreadable targets', [encrypted, null], 'encrypted'],
  ['a missing or unreadable bundle', [null], 'unknown'],
  ['a plaintext target and an unreadable target', [plaintext, null], 'unknown'],
  ['a deleted encrypted bundle', [{ ...encrypted, deleted: true }], 'unknown'],
  ['a deleted session-encrypted bundle', [{ ...sessionOnly, deleted: true }], 'unknown'],
  ['a deleted plaintext bundle', [{ ...plaintext, deleted: true }], 'unknown'],
  ['a deletion-marked bundle even when deleted is false', [{ ...encrypted, deleted_at: '2026-11-08T10:00:00.000Z' }], 'unknown'],
  ['a live plaintext target and deleted encrypted target', [plaintext, { ...encrypted, deleted: true }], 'unknown'],
  ['a builtin version', [{ ...plaintext, name: 'builtin' }], 'unknown'],
  ['an unknown version', [{ ...plaintext, name: 'unknown' }], 'unknown'],
  ['an empty version name', [{ ...plaintext, name: '' }], 'unknown'],
  ['a blank version name', [{ ...plaintext, name: '   ' }], 'unknown'],
  ['an empty key on a live bundle', [{ ...plaintext, key_id: '' }], 'plaintext'],
  ['a blank key on a live bundle', [{ ...plaintext, key_id: '   ' }], 'plaintext'],
  ['empty encryption markers on a live bundle', [{ ...plaintext, key_id: '', session_key: '' }], 'plaintext'],
  ['blank encryption markers on a live bundle', [{ ...plaintext, key_id: '   ', session_key: '   ' }], 'plaintext'],
]

describe('CI/CD production encryption evidence', () => {
  it.concurrent.each(cases)('classifies %s', (_name, bundles, expected) => {
    expect(ciProductionEncryptionEvidence(bundles)).toBe(expected)
  })

  it.concurrent('treats an omitted version name as unknown', () => {
    const bundle: CiEncryptionBundle = { ...plaintext }
    Reflect.deleteProperty(bundle, 'name')
    expect(ciProductionEncryptionEvidence([bundle])).toBe('unknown')
  })
})

describe('CI/CD production channel candidates', () => {
  const baseChannel = {
    rollout_enabled: false,
    rollout_version: 2,
    current_version: plaintext,
    rollout_bundle: encrypted,
  } satisfies CiEncryptionChannel

  it.concurrent('ignores a disabled rollout', () => {
    expect(ciChannelEncryptionBundles(baseChannel)).toEqual([plaintext])
  })

  it.concurrent('does not invent a target for an enabled but unconfigured rollout', () => {
    expect(ciChannelEncryptionBundles({ ...baseChannel, rollout_enabled: true, rollout_version: null })).toEqual([plaintext])
  })

  it.concurrent('preserves unreadable configured rollout evidence as unknown', () => {
    const bundles = ciChannelEncryptionBundles({ ...baseChannel, rollout_enabled: true, rollout_bundle: null })
    expect(bundles).toEqual([plaintext, null])
    expect(ciProductionEncryptionEvidence(bundles)).toBe('unknown')
  })

  it.concurrent.each([0, 10000])('keeps the base and enabled rollout at %i basis points', (percentageBps) => {
    const channel = {
      ...baseChannel,
      rollout_enabled: true,
      rollout_percentage_bps: percentageBps,
      rollout_paused_at: null,
    }
    const bundles = ciChannelEncryptionBundles(channel)
    expect(bundles).toEqual([plaintext, encrypted])
    expect(ciProductionEncryptionEvidence(bundles)).toBe('encrypted')
  })

  it.concurrent('keeps an enabled paused rollout because existing devices remain on it', () => {
    const channel = {
      ...baseChannel,
      rollout_enabled: true,
      rollout_percentage_bps: 0,
      rollout_paused_at: '2026-11-08T10:00:00.000Z',
    }
    expect(ciChannelEncryptionBundles(channel)).toEqual([plaintext, encrypted])
  })

  it.concurrent('keeps encrypted base evidence even at a full plaintext rollout', () => {
    const channel = {
      ...baseChannel,
      rollout_enabled: true,
      current_version: encrypted,
      rollout_bundle: plaintext,
      rollout_percentage_bps: 10000,
      rollout_paused_at: null,
    }
    expect(ciProductionEncryptionEvidence(ciChannelEncryptionBundles(channel))).toBe('encrypted')
  })
})
