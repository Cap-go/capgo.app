import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app as devicesApp } from '../supabase/functions/_backend/private/devices.ts'
import { app as statsApp } from '../supabase/functions/_backend/private/stats.ts'

const checkPermissionMock = vi.fn()
const countDevicesMock = vi.fn()
const readDevicesMock = vi.fn()
const readStatsMock = vi.fn()
const readStatsInsightsMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  countDevices: (...args: unknown[]) => countDevicesMock(...args),
  readDevices: (...args: unknown[]) => readDevicesMock(...args),
  readStats: (...args: unknown[]) => readStatsMock(...args),
  readStatsInsights: (...args: unknown[]) => readStatsInsightsMock(...args),
}))

function postJson(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function expectInvalidBody(response: Response) {
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('Invalid body')
}

async function expectRejectedStatsBody(body: Record<string, unknown>, url = 'http://local/') {
  const response = await statsApp.request(postJson(url, {
    appId: 'com.example.app',
    ...body,
  }))

  await expectInvalidBody(response)
  expect(checkPermissionMock).not.toHaveBeenCalled()
  expect(readStatsMock).not.toHaveBeenCalled()
}

async function expectRejectedDevicesBody(body: Record<string, unknown>) {
  const response = await devicesApp.request(postJson('http://local/', {
    appId: 'com.example.app',
    ...body,
  }))

  await expectInvalidBody(response)
  expect(checkPermissionMock).not.toHaveBeenCalled()
  expect(readDevicesMock).not.toHaveBeenCalled()
  expect(countDevicesMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  checkPermissionMock.mockResolvedValue(true)
  countDevicesMock.mockResolvedValue(0)
  readDevicesMock.mockResolvedValue([])
  readStatsMock.mockResolvedValue([])
  readStatsInsightsMock.mockResolvedValue({
    summary: { total: 0, device_count: 0, action_count: 0 },
    actions: [],
    daily: [],
    versions: [],
    devices: [],
  })
})

describe('private analytics route validation', () => {
  it.each([
    ['malformed deviceIds', { devicesId: ['1) OR 1=1 --'] }],
    ['malformed actions', { actions: ['get', '\' OR 1=1 --'] }],
    ['non-numeric limits', { limit: '1 UNION SELECT 1' }],
    ['decimal limits', { limit: 1.5 }],
    ['boolean limits', { limit: true }],
    ['control characters in search', { search: 'bad\u0000query' }],
    ['invalid rangeStart dates', { rangeStart: 'not-a-date' }],
  ])('rejects %s on /private/stats', async (_label, body) => {
    await expectRejectedStatsBody(body)
  })

  it('accepts backend_refusal on /private/stats', async () => {
    const response = await statsApp.request(postJson('http://local/', {
      appId: 'com.example.app',
      actions: ['backend_refusal'],
    }))

    expect(response.status).toBe(200)
    expect(checkPermissionMock).toHaveBeenCalledTimes(1)
    expect(readStatsMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes epoch range dates on /private/stats', async () => {
    const response = await statsApp.request(postJson('http://local/', {
      appId: 'com.example.app',
      rangeStart: '1704067200000',
      rangeEnd: 1704153600000,
    }))

    expect(response.status).toBe(200)
    expect(readStatsMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      start_date: '2024-01-01T00:00:00.000Z',
      end_date: '2024-01-02T00:00:00.000Z',
    }))
  })

  it('rejects malformed deviceIds on /private/stats/export', async () => {
    await expectRejectedStatsBody({
      devicesId: ['1) OR 1=1 --'],
      format: 'json',
    }, 'http://local/export')
  })

  it.each([
    ['malformed deviceIds', { devicesId: ['1) OR 1=1 --'] }],
    ['non-numeric limits', { limit: '1 UNION SELECT 1' }],
    ['decimal limits', { limit: 1.5 }],
    ['boolean limits', { limit: true }],
    ['invalid platform', { platform: 'windows' }],
  ])('rejects %s on /private/devices', async (_label, body) => {
    await expectRejectedDevicesBody(body)
  })

  it('accepts versionName on /private/stats/insights', async () => {
    const response = await statsApp.request(postJson('http://local/insights', {
      appId: 'com.example.app',
      days: 7,
      versionName: '1.2.3',
    }))

    expect(response.status).toBe(200)
    expect(readStatsInsightsMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      app_id: 'com.example.app',
      version_name: '1.2.3',
    }))
  })

  it('rejects control characters in versionName on /private/stats/insights', async () => {
    const response = await statsApp.request(postJson('http://local/insights', {
      appId: 'com.example.app',
      days: 7,
      versionName: 'bad\u0000version',
    }))

    await expectInvalidBody(response)
    expect(readStatsInsightsMock).not.toHaveBeenCalled()
  })

  it('accepts platform and versionName filters on /private/devices', async () => {
    readDevicesMock.mockResolvedValue({ data: [], nextCursor: undefined, hasMore: false })

    const response = await devicesApp.request(postJson('http://local/', {
      appId: 'com.example.app',
      platform: 'ios',
      versionName: '1.2.3',
    }))

    expect(response.status).toBe(200)
    expect(checkPermissionMock).toHaveBeenCalled()
    expect(readDevicesMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      app_id: 'com.example.app',
      platform: 'ios',
      version_name: '1.2.3',
    }), false)
  })

  it('accepts versionNames multi-select filters on /private/devices', async () => {
    readDevicesMock.mockResolvedValue({ data: [], nextCursor: undefined, hasMore: false })

    const response = await devicesApp.request(postJson('http://local/', {
      appId: 'com.example.app',
      versionNames: ['1.2.3', '2.0.0'],
    }))

    expect(response.status).toBe(200)
    expect(readDevicesMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      app_id: 'com.example.app',
      version_name: ['1.2.3', '2.0.0'],
    }), false)
  })

  it('passes platform to countDevices on /private/devices', async () => {
    countDevicesMock.mockResolvedValue(7)

    const response = await devicesApp.request(postJson('http://local/', {
      appId: 'com.example.app',
      count: true,
      platform: 'android',
      versionName: '2.0.0',
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ count: 7 })
    expect(countDevicesMock).toHaveBeenCalledWith(
      expect.anything(),
      'com.example.app',
      false,
      [],
      '2.0.0',
      undefined,
      expect.objectContaining({
        platform: 'android',
      }),
    )
  })

  it('passes osVersion compare filters on /private/devices', async () => {
    readDevicesMock.mockResolvedValue({ data: [], nextCursor: undefined, hasMore: false })

    const response = await devicesApp.request(postJson('http://local/', {
      appId: 'com.example.app',
      platform: 'android',
      osVersion: '14',
      osVersionOp: 'gte',
      versionNames: ['1.2.3'],
      versionNameOp: 'lte',
    }))

    expect(response.status).toBe(200)
    expect(readDevicesMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      app_id: 'com.example.app',
      platform: 'android',
      os_version_compare: { op: 'gte', value: '14' },
      version_name_compare: { op: 'lte', value: '1.2.3' },
    }), false)
  })

  it('rejects non-numeric osVersion on /private/devices', async () => {
    await expectRejectedDevicesBody({ osVersion: 'not-a-version', osVersionOp: 'gte' })
  })

  it('exports devices as csv on /private/devices/export', async () => {
    readDevicesMock.mockResolvedValue({
      data: [{
        device_id: '00000000-0000-0000-0000-000000000001',
        custom_id: '',
        platform: 'android',
        os_version: '14',
        version_name: '1.2.3',
        version_build: '1.0.0',
        plugin_version: '6.0.0',
        updated_at: '2026-08-19T00:00:00.000Z',
        is_prod: true,
        is_emulator: false,
        install_source: 'play_store',
        country_code: 'US',
      }],
      nextCursor: undefined,
      hasMore: false,
    })

    const response = await devicesApp.request(postJson('http://local/export', {
      appId: 'com.example.app',
      format: 'csv',
      osVersion: '14',
      osVersionOp: 'gte',
    }))

    expect(response.status).toBe(200)
    const payload = await response.json() as { format: string, csv: string, rowCount: number }
    expect(payload.format).toBe('csv')
    expect(payload.rowCount).toBe(1)
    expect(payload.csv.startsWith('device_id,custom_id,platform,os_version,version_name,version_build,plugin_version,updated_at,is_prod,is_emulator,install_source,country_code\n')).toBe(true)
    expect(readDevicesMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      os_version_compare: { op: 'gte', value: '14' },
    }), false)
  })

  it('exports devices as json on /private/devices/export', async () => {
    readDevicesMock.mockResolvedValue({
      data: [{
        device_id: '00000000-0000-0000-0000-000000000001',
        custom_id: '',
        platform: 'android',
        os_version: '14',
        version_name: '1.2.3',
        version_build: '1.0.0',
        plugin_version: '6.0.0',
        updated_at: '2026-08-19T00:00:00.000Z',
        is_prod: true,
        is_emulator: false,
        install_source: 'play_store',
        country_code: 'US',
      }],
      nextCursor: undefined,
      hasMore: false,
    })

    const response = await devicesApp.request(postJson('http://local/export', {
      appId: 'com.example.app',
      format: 'json',
      osVersion: '14',
      osVersionOp: 'gte',
    }))

    expect(response.status).toBe(200)
    const payload = await response.json() as { format: string, data: unknown[], rowCount: number, limit: number, filename?: string }
    expect(payload.format).toBe('json')
    expect(payload.rowCount).toBe(1)
    expect(payload.limit).toBe(10_000)
    expect(Array.isArray(payload.data)).toBe(true)
    expect(payload.data).toHaveLength(1)
    expect(payload.filename).toBeUndefined()
  })
})
