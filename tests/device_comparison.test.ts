import type { DeviceExistingRowLike, DeviceInfoWriteCachePayload } from '../supabase/functions/_backend/utils/deviceComparison.ts'
import type { DeviceWithoutCreatedAt } from '../supabase/functions/_backend/utils/types.ts'
import { describe, expect, it } from 'vitest'
import * as pluginRuntimeDeviceComparison from '../supabase/functions/_backend/plugin_runtime/utils/deviceComparison.ts'
import {
  buildNormalizedDeviceForWrite,
  canSkipDeviceInfoWrite,
  DEVICE_INFO_REFRESH_TTL_SECONDS,
  hasComparableDeviceChanged,
  normalizeDeviceCountryCode,
  nullableString as normalizeOptionalString,
  toComparableDevice,
  toComparableExisting,
} from '../supabase/functions/_backend/utils/deviceComparison.ts'

function device(overrides: Partial<DeviceWithoutCreatedAt> = {}): DeviceWithoutCreatedAt {
  return { device_id: 'test-device', app_id: 'test-app', platform: 'android', is_prod: false, is_emulator: false, ...overrides } as DeviceWithoutCreatedAt
}

const FULL_FIELDS = {
  platform: 'android',
  plugin_version: '1.0.0',
  os_version: '14',
  version_build: '100',
  custom_id: 'custom-123',
  version_name: 'v1.0.0',
  is_prod: true,
  is_emulator: false,
  default_channel: 'production',
} as const

const TYPICAL_PROD_DEVICE = device({
  device_id: '12345-abcde',
  app_id: 'com.example.app',
  platform: 'ios',
  plugin_version: '6.3.3',
  os_version: '17.5.1',
  version_build: '1.0.0',
  custom_id: '',
  version_name: '1.0.0',
  is_prod: true,
  default_channel: 'production',
})

// Replica column defaults: plugin_version/os_version/custom_id NOT NULL (''), version_build DEFAULT 'builtin',
// version_name/default_channel NULLABLE.
const REPLICA_DEFAULTS = {
  platform: null,
  plugin_version: '',
  os_version: '',
  version_build: 'builtin',
  custom_id: '',
  version_name: null,
  is_prod: false,
  is_emulator: false,
  default_channel: null,
  key_id: null,
}

// Simulates what cloudflare.ts writes to the replica store and reads back.
function simulateReplicaStorage(input: DeviceWithoutCreatedAt): DeviceExistingRowLike {
  const comparable = toComparableDevice(input)
  return {
    platform: comparable.platform,
    plugin_version: comparable.plugin_version,
    os_version: comparable.os_version,
    version_build: comparable.version_build,
    custom_id: comparable.custom_id,
    version_name: comparable.version_name,
    is_prod: comparable.is_prod ? 1 : 0,
    is_emulator: comparable.is_emulator ? 1 : 0,
    install_source: comparable.install_source,
    default_channel: comparable.default_channel,
    country_code: comparable.country_code,
    key_id: comparable.key_id,
  }
}

describe('normalizeOptionalString', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['test', 'test'],
    ['  ', '  '],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeOptionalString(input)).toBe(expected)
  })
})

describe('normalizeDeviceCountryCode', () => {
  it.concurrent('normalizes valid country codes', () => {
    expect(normalizeDeviceCountryCode('fr')).toBe('FR')
    expect(normalizeDeviceCountryCode(' US ')).toBe('US')
  })

  it.concurrent('rejects invalid country codes', () => {
    for (const value of [undefined, '', 'USA', '1A'])
      expect(normalizeDeviceCountryCode(value)).toBe(null)
  })
})

describe('toComparableDevice', () => {
  it('converts a device with all fields', () => {
    expect(toComparableDevice(device({ ...FULL_FIELDS, install_source: 'google_play', key_id: 'my-encryption-key' })))
      .toEqual({ ...FULL_FIELDS, install_source: 'google_play', key_id: 'my-encryption-key' })
  })

  it('normalizes empty strings and applies replica defaults', () => {
    expect(toComparableDevice(device({
      platform: 'ios',
      plugin_version: '',
      os_version: '',
      version_build: '',
      custom_id: '',
      version_name: '',
      default_channel: '',
    }))).toEqual({ ...REPLICA_DEFAULTS, platform: 'ios' })
  })

  it('applies replica defaults to undefined/null fields', () => {
    expect(toComparableDevice({
      device_id: 'test-device',
      app_id: 'test-app',
      updated_at: new Date().toISOString(),
      platform: null,
      plugin_version: undefined,
      os_version: null,
      version_build: undefined,
      custom_id: null,
      version_name: undefined,
      is_prod: undefined,
      is_emulator: undefined,
      default_channel: null,
    } as unknown as DeviceWithoutCreatedAt)).toEqual(REPLICA_DEFAULTS)
  })

  it.each([null, undefined, ''])('normalizes key_id %j to null', (keyId) => {
    expect(toComparableDevice(device({ key_id: keyId })).key_id).toBe(null)
  })

  it('treats a missing key_id field as null (backward compatibility)', () => {
    const { key_id: _omitted, ...withoutKey } = device()
    expect(toComparableDevice(withoutKey as DeviceWithoutCreatedAt).key_id).toBe(null)
  })
})

describe('toComparableExisting', () => {
  it('converts an existing device with all fields', () => {
    expect(toComparableExisting({ ...FULL_FIELDS, install_source: 'app_store', key_id: 'test-key-id' }))
      .toEqual({ ...FULL_FIELDS, install_source: 'app_store', key_id: 'test-key-id' })
  })

  it('converts numeric database booleans', () => {
    const comparable = toComparableExisting({ platform: 'ios', is_prod: 1, is_emulator: 0 })
    expect(comparable.is_prod).toBe(true)
    expect(comparable.is_emulator).toBe(false)
  })

  it('keeps null is_prod and defaults undefined is_emulator to false', () => {
    const comparable = toComparableExisting({ platform: 'android', is_prod: null, is_emulator: undefined })
    expect(comparable.is_prod).toBeNull()
    expect(comparable.is_emulator).toBe(false)
  })

  it.each([null, undefined])('returns replica defaults for a %s existing device', (existing) => {
    expect(toComparableExisting(existing)).toEqual(REPLICA_DEFAULTS)
  })

  it.each(['', undefined])('normalizes existing key_id %j to null', (keyId) => {
    expect(toComparableExisting({ platform: 'android', key_id: keyId }).key_id).toBe(null)
  })
})

describe('hasComparableDeviceChanged', () => {
  const reported = device({ platform: 'ios', plugin_version: '8.0.0', os_version: '18', version_build: '100', custom_id: '', version_name: 'v1.0.0', is_prod: true, default_channel: 'production' })

  it('compares install_source only when the client reports it', () => {
    const existing = simulateReplicaStorage({ ...reported, install_source: 'app_store' })
    expect(hasComparableDeviceChanged(existing, reported)).toBe(false)
    expect(hasComparableDeviceChanged(existing, { ...reported, install_source: 'testflight' })).toBe(true)
  })

  it.concurrent('compares country only when the backend reports it', () => {
    const existing = simulateReplicaStorage({ ...reported, country_code: 'FR' })
    expect(hasComparableDeviceChanged(existing, reported)).toBe(false)
    expect(hasComparableDeviceChanged(existing, { ...reported, country_code: 'de' })).toBe(true)
    expect(buildNormalizedDeviceForWrite({ ...reported, country_code: 'de' }).country_code).toBe('DE')
  })

  it('returns false when devices are identical', () => {
    expect(hasComparableDeviceChanged({ ...FULL_FIELDS }, device(FULL_FIELDS))).toBe(false)
  })

  it.each([
    ['plugin_version', '1.0.0', '2.0.0', true],
    ['os_version', '16.0', '17.0', true],
    ['is_prod', false, true, true],
    ['is_emulator', false, true, true],
    ['default_channel', 'production', 'development', true],
    ['custom_id', 'old-custom', 'new-custom', true],
    ['platform', 'android', 'ios', true],
    ['version_build', '100', '101', true],
    ['version_name', 'v1.0.0', 'v2.0.0', true],
    ['key_id', null, 'new-encryption-key', true],
    ['key_id', 'old-encryption-key', null, true],
    ['key_id', 'key-version-1', 'key-version-2', true],
    ['key_id', 'same-key', 'same-key', false],
    ['key_id', null, null, false],
    ['key_id', '', null, false],
    ['key_id', undefined, null, false],
    ['plugin_version', '', null, false],
    ['plugin_version', undefined, null, false],
  ] as const)('%s %j -> %j changed=%s', (field, existingValue, deviceValue, expected) => {
    const existing: DeviceExistingRowLike = { platform: 'android', is_prod: false, is_emulator: false, [field]: existingValue }
    expect(hasComparableDeviceChanged(existing, device({ [field]: deviceValue }))).toBe(expected)
  })

  it('treats numeric database booleans as equal to JS booleans', () => {
    expect(hasComparableDeviceChanged({ platform: 'android', is_prod: 1, is_emulator: 0 }, device({ is_prod: true }))).toBe(false)
  })

  it('reports a change for a new device (no existing row)', () => {
    expect(hasComparableDeviceChanged(null, device({ plugin_version: '1.0.0' }))).toBe(true)
  })

  it('treats all null/undefined/empty fields as equal', () => {
    const existing: DeviceExistingRowLike = {
      platform: null,
      plugin_version: null,
      os_version: undefined,
      version_build: '',
      custom_id: null,
      version_name: undefined,
      is_prod: null,
      is_emulator: undefined,
      default_channel: '',
    }
    expect(hasComparableDeviceChanged(existing, {
      device_id: 'test-device',
      app_id: 'test-app',
      updated_at: new Date().toISOString(),
      platform: undefined,
      plugin_version: undefined,
      os_version: null,
      version_build: null,
      custom_id: '',
      version_name: '',
      is_prod: null,
      is_emulator: undefined,
      default_channel: null,
    } as unknown as DeviceWithoutCreatedAt)).toBe(false)
  })
})

describe('buildNormalizedDeviceForWrite', () => {
  it('builds the write payload without default_channel, device_id or app_id', () => {
    const normalized = buildNormalizedDeviceForWrite(device(FULL_FIELDS))
    const { default_channel: _channel, ...writeFields } = FULL_FIELDS
    expect(normalized).toEqual({ ...writeFields, key_id: null })
    expect(normalized).not.toHaveProperty('default_channel')
    expect(normalized).not.toHaveProperty('device_id')
    expect(normalized).not.toHaveProperty('app_id')
  })

  it('normalizes empty strings and applies replica defaults', () => {
    expect(buildNormalizedDeviceForWrite(device({
      platform: 'ios',
      plugin_version: '',
      os_version: '',
      version_build: '',
      custom_id: '',
      version_name: '',
    }))).toEqual({
      version_name: null,
      platform: 'ios',
      plugin_version: '',
      os_version: '',
      version_build: 'builtin',
      custom_id: '',
      is_prod: false,
      is_emulator: false,
      key_id: null,
    })
  })

  it.each([
    ['encryption-key-456', 'encryption-key-456'],
    [null, null],
  ])('writes key_id %j as %j', (keyId, expected) => {
    expect(buildNormalizedDeviceForWrite(device({ key_id: keyId })).key_id).toBe(expected)
  })
})

describe('replica write/read cycle', () => {
  // A device re-reporting the same info after its replica row was written must not trigger another write.
  it.each([
    ['null/undefined client values', device({ plugin_version: '1.0.0', os_version: null, version_build: null, custom_id: undefined, version_name: 'v1.0.0', is_prod: true, default_channel: undefined }), {}],
    ['custom_id empty string then undefined', device({ custom_id: '' }), { custom_id: undefined }],
    ['a typical production payload', TYPICAL_PROD_DEVICE, {}],
    ['a typical production payload with key_id', { ...TYPICAL_PROD_DEVICE, key_id: 'prod-encryption-key' }, {}],
    ['default_channel empty string then undefined', device({ plugin_version: '1.0.0', is_prod: true, default_channel: '' }), { default_channel: undefined }],
    ['a full device with key_id', device({ ...FULL_FIELDS, key_id: 'my-encryption-key' }), {}],
    ['key_id null then empty string', device({ plugin_version: '1.0.0', is_prod: true, key_id: null }), { key_id: '' }],
    ['key_id undefined then null', device({ plugin_version: '1.0.0', is_prod: true, key_id: undefined }), { key_id: null }],
  ] as const)('does not detect a change for %s', (_name, first, next) => {
    expect(hasComparableDeviceChanged(simulateReplicaStorage(first), { ...first, ...next })).toBe(false)
  })

  it.each([
    ['plugin_version upgrade', device({ plugin_version: '6.0.0', is_prod: true }), { plugin_version: '6.1.0' }],
    ['os_version upgrade', device({ platform: 'ios', os_version: '17.0', is_prod: true }), { os_version: '17.5' }],
    ['switching from prod to dev', device({ is_prod: true }), { is_prod: false }],
    ['key_id rotation', device({ plugin_version: '1.0.0', is_prod: true, key_id: 'encryption-key-v1' }), { key_id: 'encryption-key-v2' }],
  ] as const)('detects %s', (_name, first, next) => {
    expect(hasComparableDeviceChanged(simulateReplicaStorage(first), { ...first, ...next })).toBe(true)
  })

  it('stores NOT NULL replica columns as empty strings and default_channel as null', () => {
    const stored = simulateReplicaStorage(device({ plugin_version: null, os_version: null, default_channel: null, is_prod: true }))
    expect(stored.plugin_version).toBe('')
    expect(stored.os_version).toBe('')
    expect(stored.default_channel).toBe(null)
  })
})

describe('canSkipDeviceInfoWrite (trackDevicesCF colo cache)', () => {
  const cachedDevice = device({
    device_id: 'cache-device',
    app_id: 'com.example.cache',
    platform: 'ios',
    plugin_version: '7.0.0',
    os_version: '17',
    version_build: '1.0.0',
    custom_id: '',
    version_name: '2.0.0',
    is_prod: true,
    default_channel: 'production',
  })
  const nowMs = Date.parse('2026-09-30T12:00:00.000Z')
  const ttlMs = DEVICE_INFO_REFRESH_TTL_SECONDS * 1000

  function cachedAt(ageMs: number, overrides: Partial<DeviceWithoutCreatedAt> = {}): DeviceInfoWriteCachePayload {
    return {
      ...toComparableDevice({ ...cachedDevice, ...overrides }),
      app_id: cachedDevice.app_id,
      device_id: cachedDevice.device_id,
      cached_at: new Date(nowMs - ageMs).toISOString(),
    }
  }

  it('skips the write for an unchanged device written recently', () => {
    expect(canSkipDeviceInfoWrite(cachedAt(60_000), cachedDevice, nowMs)).toBe(true)
    expect(canSkipDeviceInfoWrite(cachedAt(ttlMs - 1), cachedDevice, nowMs)).toBe(true)
  })

  it('forces a write when there is no cache entry', () => {
    expect(canSkipDeviceInfoWrite(null, cachedDevice, nowMs)).toBe(false)
    expect(canSkipDeviceInfoWrite(undefined, cachedDevice, nowMs)).toBe(false)
  })

  it('forces a refresh once the last write is older than the one-day TTL, even if unchanged', () => {
    expect(canSkipDeviceInfoWrite(cachedAt(ttlMs), cachedDevice, nowMs)).toBe(false)
    expect(canSkipDeviceInfoWrite(cachedAt(24 * 60 * 60 * 1000), cachedDevice, nowMs)).toBe(false)
    // Entries written under the previous one-year cache max-age.
    expect(canSkipDeviceInfoWrite(cachedAt(200 * 24 * 60 * 60 * 1000), cachedDevice, nowMs)).toBe(false)
  })

  it('forces a write when the device changed (for example a rollback)', () => {
    expect(canSkipDeviceInfoWrite(cachedAt(60_000, { version_name: '1.0.0' }), cachedDevice, nowMs)).toBe(false)
  })

  it('forces a write for missing, invalid or future write timestamps', () => {
    const entry = cachedAt(60_000)
    expect(canSkipDeviceInfoWrite({ ...entry, cached_at: 'not-a-date' }, cachedDevice, nowMs)).toBe(false)
    expect(canSkipDeviceInfoWrite({ ...entry, cached_at: undefined as unknown as string }, cachedDevice, nowMs)).toBe(false)
    expect(canSkipDeviceInfoWrite({ ...entry, cached_at: new Date(nowMs + 60_000).toISOString() }, cachedDevice, nowMs)).toBe(false)
  })

  it('keeps the plugin_runtime copy in sync', () => {
    expect(pluginRuntimeDeviceComparison.DEVICE_INFO_REFRESH_TTL_SECONDS).toBe(DEVICE_INFO_REFRESH_TTL_SECONDS)
    expect(pluginRuntimeDeviceComparison.canSkipDeviceInfoWrite(cachedAt(60_000), cachedDevice, nowMs)).toBe(true)
    expect(pluginRuntimeDeviceComparison.canSkipDeviceInfoWrite(cachedAt(ttlMs + 1), cachedDevice, nowMs)).toBe(false)
  })
})
