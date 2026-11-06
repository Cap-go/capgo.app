import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseJsonc, WRANGLER_PATH } from '../scripts/generate-plugin-route-hosts.ts'
import { consumerAddArgs, logpushJobBody, logpushJobNeedsUpdate, parseEnvFile, r2CredentialsOfToken, resolveSetupEnv, STAT_HEADER, withStatHeaderField } from '../scripts/setup-snippet-edge-stats.ts'

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

  it('updates an existing Logpush job only when a setting differs', () => {
    const { destination_conf: _destination, ...current } = logpushJobBody('r2://bucket/{DATE}')
    expect(logpushJobNeedsUpdate({ id: 1, ...current })).toBe(false)
    expect(logpushJobNeedsUpdate({ id: 1, ...current, filter: null })).toBe(true)
    expect(logpushJobNeedsUpdate({ id: 1, ...current, output_options: { ...current.output_options, field_names: ['ResponseHeaders'] } })).toBe(true)
    expect(logpushJobNeedsUpdate({ id: 1, ...current, enabled: false })).toBe(true)
    expect(logpushJobNeedsUpdate({ id: 1, ...current, max_upload_records: 100_000 })).toBe(true)
  })

  it('reads unset values from the prod env file names', () => {
    const file = parseEnvFile('# comment\nCF_ACCOUNT_ANALYTICS_ID=acc\nexport CF_ANALYTICS_TOKEN="tok"\nS3_ACCESS_KEY_ID=key # note\nZONE_NAME=\'zone\'\n')
    expect(resolveSetupEnv({}, file)).toEqual({ accountId: 'acc', apiToken: 'tok', r2AccessKeyId: '', r2SecretAccessKey: '', zoneName: 'zone' })
    expect(resolveSetupEnv({ CLOUDFLARE_ACCOUNT_ID: 'env', CLOUDFLARE_API_TOKEN: 'env-token', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' }, file)).toMatchObject({ accountId: 'env', apiToken: 'env-token', r2AccessKeyId: 'id', r2SecretAccessKey: 'secret' })
  })

  it('derives the R2 S3 credentials of an API token', () => {
    expect(r2CredentialsOfToken({ id: 'token-id', value: 'abc' })).toEqual({ accessKeyId: 'token-id', secretAccessKey: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })
  })

  it('attaches the stats queue consumers of the EU worker config', () => {
    expect(consumerAddArgs(parseJsonc(readFileSync(WRANGLER_PATH, 'utf8')))).toEqual([
      ['queues', 'consumer', 'add', 'capgo-snippet-edge-stats-files', 'capgo_plugin-eu-prod', '--batch-size', '10', '--batch-timeout', '5', '--message-retries', '3', '--dead-letter-queue', 'capgo-snippet-edge-stats-dlq'],
      ['queues', 'consumer', 'add', 'capgo-snippet-edge-stats-replay', 'capgo_plugin-eu-prod', '--batch-size', '1', '--batch-timeout', '1', '--message-retries', '2', '--dead-letter-queue', 'capgo-snippet-edge-stats-dlq'],
    ])
  })
})
