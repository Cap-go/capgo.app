import { describe, expect, it } from 'vitest'
import { logpushJobBody, STAT_HEADER, withStatHeaderField } from '../scripts/setup-snippet-edge-stats.ts'

describe('snippet-edge-stats:setup', () => {
  it('adds the stat header to the custom log fields without dropping existing ones', () => {
    expect(withStatHeaderField([])).toEqual([expect.objectContaining({ action: 'log_custom_field', expression: 'true', action_parameters: { response_fields: [{ name: STAT_HEADER }] } })])

    const existing = [{ id: 'r1', action: 'log_custom_field', expression: 'true', action_parameters: { request_fields: [{ name: 'user-agent' }], response_fields: [{ name: 'cf-cache-status' }] } }]
    expect(withStatHeaderField(existing)).toEqual([{ ...existing[0], action_parameters: { request_fields: [{ name: 'user-agent' }], response_fields: [{ name: 'cf-cache-status' }, { name: STAT_HEADER }] } }])

    const configured = withStatHeaderField(existing)
    expect(withStatHeaderField(configured)).toBe(configured)
  })

  it('pushes plugin calls with the response headers', () => {
    const job = logpushJobBody('r2://bucket/{DATE}')
    expect(job.dataset).toBe('http_requests')
    expect(job.output_options.field_names).toContain('ResponseHeaders')
    expect(JSON.parse(job.filter).where.or.map((condition: { value: string }) => condition.value)).toEqual(['/updates', '/stats', '/plugin/updates', '/plugin/stats'])
  })
})
