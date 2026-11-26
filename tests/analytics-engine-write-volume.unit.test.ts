import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn(error => error),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: vi.fn(() => Promise.resolve()),
  }
})

function createContext(env: Record<string, any>) {
  return {
    env,
    get: (key: string) => (key === 'requestId' ? 'request-id' : undefined),
    header: vi.fn(),
    json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status }),
    req: {
      raw: {
        cf: {},
        headers: new Headers(),
      },
      url: 'http://localhost/test',
    },
    res: {
      headers: new Headers(),
    },
  } as any
}

const device = {
  app_id: 'com.example.app',
  device_id: 'device-1',
  version_name: '1.0.0',
  platform: 'android',
  plugin_version: '8.0.0',
} as any

function mockRandomUint32(value: number) {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
    array[0] = value
    return array
  }) as typeof crypto.getRandomValues)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('analytics engine write volume', () => {
  it.each(['download_10', 'download_50', 'download_90'])('drops %s progress from APP_LOG', async (action) => {
    const { createStatsLogs } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    const writeDataPoint = vi.fn()
    await createStatsLogs(createContext({ APP_LOG: { writeDataPoint } }), 'com.example.app', 'device-1', action as any, '1.0.0')
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('retains every milestone for a sampled attempt and independently samples retries', async () => {
    const { createStatsLogs } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    const writeDataPoint = vi.fn()
    const context = createContext({ APP_LOG: { writeDataPoint } })
    for (const attempt of ['1469', '1470']) {
      for (const action of ['download_10', 'download_50', 'download_90'] as const)
        await createStatsLogs(context, 'com.example.app', 'device-1', action, '1.0.0', { attempt_id: attempt })
    }
    expect(writeDataPoint.mock.calls.map(([point]) => point.blobs[1])).toEqual(['download_10', 'download_50', 'download_90'])
    expect(writeDataPoint.mock.calls.map(([point]) => point.doubles)).toEqual([[0, 1000], [0, 1000], [0, 1000]])
    expect(writeDataPoint.mock.calls.every(([point]) => JSON.parse(point.blobs[3]).attempt_id === '1469')).toBe(true)
  })

  it.each(['download_0', 'download_complete', 'download_fail', 'get', 'set'])('keeps %s in APP_LOG', async (action) => {
    const { createStatsLogs } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    const writeDataPoint = vi.fn()
    await createStatsLogs(createContext({ APP_LOG: { writeDataPoint } }), 'com.example.app', 'device-1', action as any, '1.0.0')
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
  })

  it('drops heartbeat logs and keeps one device cohort for sampled actions', async () => {
    const { APP_LOG_VOLUME_SAMPLE_RATE, appLogDeviceKept, trackLogsCF } = await import('../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts')
    const writeDataPoint = vi.fn()
    const c = createContext({ APP_LOG: { writeDataPoint } })
    let kept = ''
    let skipped = ''
    for (let i = 0; i < 200 && (!kept || !skipped); i++) {
      const id = `device-${i}`
      if (appLogDeviceKept(id))
        kept = kept || id
      else
        skipped = skipped || id
    }
    expect(kept).not.toBe('')
    expect(skipped).not.toBe('')

    for (const action of ['noNew', 'app_moved_to_foreground', 'getChannel'] as const)
      await trackLogsCF(c, 'com.example.app', kept, action, '1.0.0')
    expect(writeDataPoint).not.toHaveBeenCalled()

    await trackLogsCF(c, 'com.example.app', skipped, 'webview_page_loaded', '1.0.0', { duration_ms: '15' })
    await trackLogsCF(c, 'com.example.app', skipped, 'webview_page_loaded', '1.0.0', { duration_ms: '15' })
    expect(writeDataPoint).not.toHaveBeenCalled()

    await trackLogsCF(c, 'com.example.app', kept, 'webview_page_loaded', '1.0.0', { duration_ms: '15' })
    await trackLogsCF(c, 'com.example.app', kept, 'webview_page_loaded', '1.0.0', { duration_ms: '15' })
    expect(writeDataPoint).toHaveBeenCalledTimes(2)
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      doubles: [15, APP_LOG_VOLUME_SAMPLE_RATE],
    }))
  })

  it('keeps launch, install and failure logs out of the volume sample', async () => {
    const { appLogDeviceKept, trackLogsCF } = await import('../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts')
    const writeDataPoint = vi.fn()
    const c = createContext({ APP_LOG: { writeDataPoint } })
    let skipped = 'device-0'
    for (let i = 0; i < 200; i++) {
      if (!appLogDeviceKept(`device-${i}`)) {
        skipped = `device-${i}`
        break
      }
    }
    for (const action of ['app_launch_ready', 'set', 'get', 'download_fail', 'app_crash'] as const)
      await trackLogsCF(c, 'com.example.app', skipped, action, '1.0.0')
    expect(writeDataPoint).toHaveBeenCalledTimes(5)
    for (const [point] of writeDataPoint.mock.calls)
      expect(point.doubles).toBeUndefined()
  })

  it('uses the same app_log volume sample on the plugin and API paths', async () => {
    const plugin = await import('../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts')
    const api = await import('../supabase/functions/_backend/utils/cloudflare.ts')
    expect(plugin.APP_LOG_VOLUME_SAMPLE_RATE).toBe(api.APP_LOG_VOLUME_SAMPLE_RATE)
    expect([...plugin.APP_LOG_DROPPED_ACTIONS]).toEqual([...api.APP_LOG_DROPPED_ACTIONS])
    expect([...plugin.APP_LOG_VOLUME_SAMPLED_ACTIONS]).toEqual([...api.APP_LOG_VOLUME_SAMPLED_ACTIONS])

    let kept = ''
    let skipped = ''
    for (let i = 0; i < 200 && (!kept || !skipped); i++) {
      const id = `parity-device-${i}`
      if (plugin.appLogDeviceKept(id) !== api.appLogDeviceKept(id))
        throw new Error(`sample decision diverged for ${id}`)
      if (plugin.appLogDeviceKept(id))
        kept = kept || id
      else
        skipped = skipped || id
    }

    async function written(track: typeof plugin.trackLogsCF) {
      const writeDataPoint = vi.fn()
      const c = createContext({ APP_LOG: { writeDataPoint } })
      await track(c, 'com.example.app', kept, 'webview_page_loaded', '1.0.0', { duration_ms: '15' })
      await track(c, 'com.example.app', kept, 'webview_page_loaded', '1.0.0', { duration_ms: '15' })
      await track(c, 'com.example.app', skipped, 'webview_page_loaded', '1.0.0', { duration_ms: '15' })
      await track(c, 'com.example.app', kept, 'noNew', '1.0.0')
      await track(c, 'com.example.app', skipped, 'app_launch_ready', '1.0.0')
      return writeDataPoint.mock.calls.map(([point]) => point)
    }

    expect(await written(plugin.trackLogsCF)).toEqual(await written(api.trackLogsCF))
  })

  it('scales population totals and leaves one device\'s own count unscaled', async () => {
    const { readStatsInsightsCF } = await import('../supabase/functions/_backend/utils/cloudflare.ts')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ meta: [], data: [] })))
    const c = createContext({ CF_ACCOUNT_ANALYTICS_ID: 'account', CF_ANALYTICS_TOKEN: 'token', APP_LOG: {} })
    await readStatsInsightsCF(c, { app_id: 'com.example.app', start_date: '2026-11-01', end_date: '2026-11-02' })
    const bodies = fetchMock.mock.calls.map(([, init]) => String(init?.body))
    const deviceQuery = bodies.find(body => body.includes('GROUP BY action, device_id'))
    const actionQuery = bodies.find(body => body.includes('GROUP BY action'))
    expect(deviceQuery).toContain('sum(_sample_interval) AS total')
    expect(deviceQuery).not.toContain('double2')
    expect(actionQuery).toContain('sum(_sample_interval * if(double2 > 0, double2, 1.0))')
    expect(actionQuery).toContain('sample_rate_min')
    const summaryQuery = bodies.find(body => !body.includes('GROUP BY'))
    expect(summaryQuery).toContain('sample_rate_min')
  })

  it('samples APP_LOG_EXTERNAL and stores the sample rate in double2', async () => {
    const { APP_LOG_EXTERNAL_SAMPLE_RATE, trackLogsCFExternal } = await import('../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts')
    const writeDataPoint = vi.fn()
    const c = createContext({ APP_LOG_EXTERNAL: { writeDataPoint } })

    mockRandomUint32(1)
    await trackLogsCFExternal(c, 'com.example.app', 'device-1', 'get', '1.0.0')
    expect(writeDataPoint).not.toHaveBeenCalled()

    mockRandomUint32(APP_LOG_EXTERNAL_SAMPLE_RATE * 3)
    await trackLogsCFExternal(c, 'com.example.app', 'device-1', 'get', '1.0.0')
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      doubles: [0, APP_LOG_EXTERNAL_SAMPLE_RATE],
      indexes: ['com.example.app'],
    }))
  })

  it('only logs real update checks from on-prem apps to APP_LOG_EXTERNAL', async () => {
    const { onPremStats } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    mockRandomUint32(0)
    const writeDataPoint = vi.fn()
    const c = createContext({ APP_LOG_EXTERNAL: { writeDataPoint } })

    await onPremStats(c, 'com.example.app', 'app_moved_to_foreground', device)
    expect(writeDataPoint).not.toHaveBeenCalled()

    await onPremStats(c, 'com.example.app', 'get', device)
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBe('get')
  })

  it('omits APP_LOG dimension blobs when device data collection flags are off', async () => {
    const { sendStatsAndDevice } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    const { DEFAULT_DEVICE_DATA_COLLECTION } = await import('../supabase/functions/_backend/plugin_runtime/utils/deviceDataCollection.ts')
    const writeDataPoint = vi.fn()
    const collection = {
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      country: false,
      platform: false,
      plugin_version: false,
    }
    await sendStatsAndDevice(
      createContext({ APP_LOG: { writeDataPoint } }),
      {
        app_id: 'com.example.app',
        device_id: 'device-1',
        version_name: '1.0.0',
        platform: 'ios',
        plugin_version: '8.0.0',
        os_version: '18.0',
        version_build: '2.0.0',
        custom_id: '',
        is_prod: true,
        is_emulator: false,
        install_source: 'app_store',
        country_code: 'US',
      } as any,
      [{ action: 'set' }],
      true,
      collection,
    )
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      blobs: ['device-1', 'set', '1.0.0', '', '', '', '', '', ''],
    }))
  })

  it('flags a failure log that was not counted as a version fail in blob10', async () => {
    const { sendStatsAndDevice } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    const { DEFAULT_DEVICE_DATA_COLLECTION } = await import('../supabase/functions/_backend/plugin_runtime/utils/deviceDataCollection.ts')
    const writeDataPoint = vi.fn()
    await sendStatsAndDevice(
      createContext({ APP_LOG: { writeDataPoint } }),
      {
        app_id: 'com.example.app',
        device_id: 'device-1',
        version_name: '1.0.0',
        platform: 'ios',
        plugin_version: '8.51.16',
        os_version: '18.0',
        version_build: '2.0.0',
        custom_id: '',
        is_prod: true,
        is_emulator: false,
        install_source: 'app_store',
        country_code: 'US',
      } as any,
      [{ action: 'download_fail', uncountedFailure: true }, { action: 'update_fail' }],
      true,
      { ...DEFAULT_DEVICE_DATA_COLLECTION, country: false },
    )
    expect(writeDataPoint.mock.calls.map(([point]) => point.blobs)).toEqual([
      ['device-1', 'download_fail', '1.0.0', '', 'ios', '', '8.51.16', '', '', '1'],
      ['device-1', 'update_fail', '1.0.0', '', 'ios', '', '8.51.16', '', ''],
    ])
  })

  it('omits DEVICE_INFO blobs for disabled collection fields', async () => {
    const { trackDevicesCF } = await import('../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts')
    const { applyDeviceDataCollectionToDevice, DEFAULT_DEVICE_DATA_COLLECTION } = await import('../supabase/functions/_backend/plugin_runtime/utils/deviceDataCollection.ts')
    const writeDataPoint = vi.fn()
    const source = {
      app_id: 'com.example.app',
      device_id: 'device-1',
      version_name: '1.0.0',
      platform: 'ios',
      plugin_version: '8.0.0',
      os_version: '18.0',
      custom_id: 'cid',
      version_build: '2.0.0',
      default_channel: 'production',
      key_id: '',
      install_source: 'app_store',
      country_code: 'US',
      is_prod: true,
      is_emulator: false,
    }
    const stored = applyDeviceDataCollectionToDevice(source, {
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      country: false,
      platform: false,
      os_version: false,
      plugin_version: false,
      version_build: false,
      is_emulator: false,
      is_prod: false,
      install_source: false,
    }) as typeof source

    await trackDevicesCF(createContext({ DEVICE_INFO: { writeDataPoint } }), stored as any)
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      blobs: ['device-1', '1.0.0', '', '', 'cid', 'builtin', 'production', '', '', ''],
      doubles: [-1, -1, -1],
      indexes: ['com.example.app'],
    }))
  })

  it('scales the external update count by the stored sample rate', async () => {
    const { countUpdatesFromLogsExternalCF } = await import('../supabase/functions/_backend/utils/cloudflare.ts')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ meta: [{ name: 'count', type: 'Float64' }], data: [{ count: 1236.7 }] })))
    const c = createContext({ CF_ACCOUNT_ANALYTICS_ID: 'account', CF_ANALYTICS_TOKEN: 'token' })

    await expect(countUpdatesFromLogsExternalCF(c)).resolves.toBe(1237)
    const body = String(fetchMock.mock.calls[0][1]?.body)
    expect(body).toContain('SUM(_sample_interval * if(double2 > 0, double2, 1.0))')
  })
})
