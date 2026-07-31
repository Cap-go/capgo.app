import { describe, expect, it } from 'vitest'

import { APP_NAME_STATS, fetchTestRequest, getEndpointUrl, headersStats } from './test-utils.ts'

describe('[POST] /private/stats/export', () => {
  it('exports logs as CSV (apikey auth)', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/stats/export'), {
      method: 'POST',
      headers: headersStats,
      body: JSON.stringify({
        appId: APP_NAME_STATS,
        format: 'csv',
        limit: 10,
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as {
      format: string
      filename: string
      contentType: string
      csv: string
      rowCount: number
      limit: number
    }

    expect(data.format).toBe('csv')
    expect(data.filename).toMatch(/capgo-logs-/)
    expect(data.contentType).toContain('text/csv')
    expect(typeof data.csv).toBe('string')
    expect(data.csv.startsWith('created_at,app_id,device_id,action,version_name,metadata\n')).toBe(true)
    // Always ends with a newline for spreadsheet compatibility.
    expect(data.csv.endsWith('\n')).toBe(true)
    expect(data.limit).toBe(10)
    expect(typeof data.rowCount).toBe('number')
  })

  it('exports logs as JSON (apikey auth)', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/stats/export'), {
      method: 'POST',
      headers: headersStats,
      body: JSON.stringify({
        appId: APP_NAME_STATS,
        format: 'json',
        limit: 5,
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { format: string, data: unknown[], limit: number, rowCount: number }
    expect(data.format).toBe('json')
    expect(Array.isArray(data.data)).toBe(true)
    expect(data.limit).toBe(5)
    expect(typeof data.rowCount).toBe('number')
  })
})
