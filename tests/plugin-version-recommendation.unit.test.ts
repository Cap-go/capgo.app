import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPluginVersionRecommendation,
  fetchUpdaterDistTags,
  installCommandForPackage,
  latestTagForMajor,
  MIN_SUPPORTED_PLUGIN_MAJOR,
  pluginMajorFromVersion,
  resetUpdaterDistTagCache,
  UPDATER_PACKAGE_NAME,
} from '../src/services/pluginVersionRecommendation.ts'

const distTags = {
  'latest': '8.51.15',
  'lts-v4': '4.43.5',
  'lts-v5': '5.50.2',
  'lts-v6': '6.50.2',
  'lts-v7': '7.51.15',
}

describe('plugin version recommendation helpers', () => {
  it.concurrent('reads the plugin major from a reported version', () => {
    expect(pluginMajorFromVersion('6.14.0')).toBe(6)
    expect(pluginMajorFromVersion('unknown')).toBeNull()
    expect(pluginMajorFromVersion('')).toBeNull()
  })

  it.concurrent('uses latest when the npm latest tag already matches that major', () => {
    expect(latestTagForMajor(8, distTags)).toEqual({ tag: 'latest', version: '8.51.15' })
    expect(latestTagForMajor(6, distTags)).toEqual({ tag: 'lts-v6', version: '6.50.2' })
    expect(latestTagForMajor(9, distTags)).toBeNull()
  })

  it.concurrent('builds a customer-facing npm install command', () => {
    expect(installCommandForPackage(`${UPDATER_PACKAGE_NAME}@lts-v6`)).toBe('npm install @capgo/capacitor-updater@lts-v6')
  })
})

describe('buildPluginVersionRecommendation', () => {
  it.concurrent('suggests the latest matching major when the most reported version is behind', () => {
    const recommendation = buildPluginVersionRecommendation([
      { plugin_version: '6.14.0', devices: 80, total_devices: 100 },
      { plugin_version: '6.50.2', devices: 20, total_devices: 100 },
    ], distTags)

    expect(recommendation?.dominantVersion).toBe('6.14.0')
    expect(recommendation?.dominantMajor).toBe(6)
    expect(recommendation?.recommendedVersion).toBe('6.50.2')
    expect(recommendation?.recommendedTag).toBe('lts-v6')
    expect(recommendation?.installCommand).toBe('npm install @capgo/capacitor-updater@lts-v6')
    expect(recommendation?.needsUpdate).toBe(true)
    expect(recommendation?.unsupported).toBe(false)
    expect(recommendation?.behindDevices).toBe(80)
    expect(recommendation?.behindShare).toBe(80)
    expect(recommendation?.statusResolved).toBe(true)
    expect(recommendation?.currentDevices).toBe(20)
    expect(recommendation?.majors).toEqual([
      expect.objectContaining({
        major: 6,
        devices: 100,
        latestVersion: '6.50.2',
        behindDevices: 80,
        currentDevices: 20,
        unsupported: false,
        statusResolved: true,
      }),
    ])
    expect(recommendation?.rows[0]).toMatchObject({ plugin_version: '6.14.0', status: 'behind', latestForMajor: '6.50.2' })
    expect(recommendation?.rows[1]).toMatchObject({ plugin_version: '6.50.2', status: 'current' })
  })

  it.concurrent('does not nag when the most reported version already matches the latest for that major', () => {
    const recommendation = buildPluginVersionRecommendation([
      { plugin_version: '7.51.15', devices: 9, total_devices: 10 },
      { plugin_version: '7.40.0', devices: 1, total_devices: 10 },
    ], distTags)

    expect(recommendation?.needsUpdate).toBe(false)
    expect(recommendation?.recommendedVersion).toBe('7.51.15')
    expect(recommendation?.behindDevices).toBe(1)
    expect(recommendation?.installPackage).toBe('@capgo/capacitor-updater@lts-v7')
  })

  it.concurrent('flags unsupported v4 fleets even when a v4 LTS still exists', () => {
    const recommendation = buildPluginVersionRecommendation([
      { plugin_version: '4.15.3', devices: 2, total_devices: 3 },
      { plugin_version: '7.0.0', devices: 1, total_devices: 3 },
    ], distTags)

    expect(MIN_SUPPORTED_PLUGIN_MAJOR).toBe(5)
    expect(recommendation?.unsupported).toBe(true)
    expect(recommendation?.needsUpdate).toBe(true)
    expect(recommendation?.installCommand).toBeNull()
    expect(recommendation?.majors[0]).toMatchObject({
      major: 4,
      latestVersion: '4.43.5',
      unsupported: true,
      behindDevices: 2,
    })
    expect(recommendation?.majors[1]).toMatchObject({
      major: 7,
      latestVersion: '7.51.15',
      behindDevices: 1,
    })
    expect(recommendation?.behindDevices).toBe(3)
  })

  it.concurrent('does not treat unsupported majors as resolved until npm tags are known', () => {
    const recommendation = buildPluginVersionRecommendation([
      { plugin_version: '4.15.3', devices: 2, total_devices: 2 },
    ], null)

    expect(recommendation?.needsUpdate).toBe(false)
    expect(recommendation?.unsupported).toBe(false)
    expect(recommendation?.statusResolved).toBe(false)
    expect(recommendation?.behindDevices).toBe(0)
    expect(recommendation?.currentDevices).toBe(0)
    expect(recommendation?.recommendedVersion).toBeNull()
    expect(recommendation?.rows[0]?.status).toBe('unsupported')
  })

  it.concurrent('does not invent an update when tags are missing for a supported major', () => {
    const recommendation = buildPluginVersionRecommendation([
      { plugin_version: '6.14.0', devices: 4, total_devices: 4 },
    ], null)

    expect(recommendation?.needsUpdate).toBe(false)
    expect(recommendation?.statusResolved).toBe(false)
    expect(recommendation?.behindDevices).toBe(0)
    expect(recommendation?.currentDevices).toBe(0)
    expect(recommendation?.majors[0]).toMatchObject({
      behindDevices: 0,
      currentDevices: 0,
      statusResolved: false,
    })
    expect(recommendation?.rows[0]?.status).toBe('unknown')
  })

  it.concurrent('does not count a supported major as current when no matching dist-tag exists', () => {
    const recommendation = buildPluginVersionRecommendation([
      { plugin_version: '9.1.0', devices: 4, total_devices: 4 },
    ], distTags)

    expect(recommendation?.statusResolved).toBe(false)
    expect(recommendation?.behindDevices).toBe(0)
    expect(recommendation?.currentDevices).toBe(0)
    expect(recommendation?.majors[0]).toMatchObject({
      major: 9,
      behindDevices: 0,
      currentDevices: 0,
      statusResolved: false,
    })
    expect(recommendation?.rows[0]?.status).toBe('unknown')
  })

  it.concurrent('returns null when there is no plugin version data', () => {
    expect(buildPluginVersionRecommendation([], distTags)).toBeNull()
  })
})

describe('fetchUpdaterDistTags', () => {
  afterEach(() => {
    resetUpdaterDistTagCache()
    vi.unstubAllGlobals()
  })

  it('caches npm dist-tags after a successful fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ 'dist-tags': distTags }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUpdaterDistTags()).resolves.toEqual(distTags)
    await expect(fetchUpdaterDistTags()).resolves.toEqual(distTags)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null when the npm registry request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(fetchUpdaterDistTags()).resolves.toBeNull()
  })

  it('deduplicates concurrent requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ 'dist-tags': distTags }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([fetchUpdaterDistTags(), fetchUpdaterDistTags()])

    expect(first).toEqual(distTags)
    expect(second).toEqual(distTags)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ 'dist-tags': distTags }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUpdaterDistTags()).resolves.toBeNull()
    await expect(fetchUpdaterDistTags()).resolves.toEqual(distTags)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
