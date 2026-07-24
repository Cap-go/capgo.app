import { HTTPException } from 'hono/http-exception'
import { describe, expect, it, vi } from 'vitest'
import { __queueConsumerTestUtils__, MAX_QUEUE_READS, messagesArraySchema } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import { onManifestCreateTestUtils } from '../supabase/functions/_backend/triggers/on_manifest_create.ts'
import { onVersionUpdateTestUtils } from '../supabase/functions/_backend/triggers/on_version_update.ts'
import { s3TestUtils } from '../supabase/functions/_backend/utils/s3.ts'
import { parseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'

describe('queue_consumer legacy message compatibility', () => {
  it.concurrent('uses the payload envelope when it is present', () => {
    const [message] = parseSchema(messagesArraySchema, [
      {
        msg_id: 1,
        read_ct: 0,
        message: {
          function_name: 'cron_sync_sub',
          function_type: 'cloudflare',
          payload: {
            orgId: 'org-1',
            customerId: 'cus_1',
          },
        },
      },
    ])

    expect(__queueConsumerTestUtils__.extractMessageBody(message!)).toEqual({
      orgId: 'org-1',
      customerId: 'cus_1',
    })
  })

  it.concurrent('falls back to legacy top-level fields when payload is missing', () => {
    const [message] = parseSchema(messagesArraySchema, [
      {
        msg_id: 2,
        read_ct: 0,
        message: {
          function_name: 'cron_sync_sub',
          orgId: 'org-legacy',
          customerId: 'cus_legacy',
        },
      },
    ])

    expect(__queueConsumerTestUtils__.extractMessageBody(message!)).toEqual({
      orgId: 'org-legacy',
      customerId: 'cus_legacy',
    })
  })

  it.concurrent('drops legacy routing metadata from fallback bodies', () => {
    const [message] = parseSchema(messagesArraySchema, [
      {
        msg_id: 3,
        read_ct: 0,
        message: {
          function_name: 'cron_sync_sub',
        },
      },
    ])

    expect(__queueConsumerTestUtils__.extractMessageBody(message!)).toEqual({})
  })

  it.concurrent('summarizes app version update queue payloads for logs', () => {
    expect(__queueConsumerTestUtils__.getQueueMessageTrace('on_version_update', {
      old_record: {
        deleted_at: null,
        r2_path: null,
        storage_provider: 'r2-direct',
        updated_at: '2026-06-10T17:33:48.108Z',
      },
      record: {
        app_id: 'at.pulserunning.rny',
        deleted_at: null,
        id: 181090948,
        manifest: [{ file_name: 'index.html' }, { file_name: 'assets/app.js' }],
        manifest_count: 0,
        name: '1.7.0',
        r2_path: 'orgs/org-id/apps/at.pulserunning.rny/1.7.0.zip',
        storage_provider: 'r2',
        updated_at: '2026-06-10T17:33:48.559Z',
      },
      table: 'app_versions',
      type: 'UPDATE',
    })).toEqual({
      app_id: 'at.pulserunning.rny',
      deleted_at: null,
      id: 181090948,
      manifest_count: 0,
      manifest_entries: 2,
      old_deleted_at: null,
      old_r2_path: null,
      old_storage_provider: 'r2-direct',
      old_updated_at: '2026-06-10T17:33:48.108Z',
      r2_path: 'orgs/org-id/apps/at.pulserunning.rny/1.7.0.zip',
      storage_provider: 'r2',
      updated_at: '2026-06-10T17:33:48.559Z',
      version_name: '1.7.0',
    })
  })

  it.concurrent('does not summarize unrelated queue payloads', () => {
    expect(__queueConsumerTestUtils__.getQueueMessageTrace('cron_sync_sub', {
      customerId: 'cus_1',
      orgId: 'org-1',
    })).toBeNull()
  })

  it.concurrent('does not alert Discord while failed messages still have retries left', () => {
    expect(__queueConsumerTestUtils__.getActionableQueueFailures([
      {
        cf_id: 'cf-1',
        function_name: 'on_version_update',
        function_type: 'supabase',
        msg_id: 1,
        payload_size: 10,
        read_count: 1,
        status: 502,
        status_text: 'Bad Gateway',
      },
    ])).toEqual([])
  })

  it.concurrent('keeps a 950-row manifest batch under Cloudflare subrequest limits', () => {
    expect(onManifestCreateTestUtils.sizeRetryAttempts).toBe(1)
    expect(s3TestUtils.shouldUseSizeRangeFallback(0, { status: 404 })).toBe(false)
    expect(s3TestUtils.shouldUseSizeRangeFallback(0, { statusCode: 404 })).toBe(false)
    expect(s3TestUtils.shouldUseSizeRangeFallback(0, { code: 'NoSuchKey' })).toBe(false)
    expect(s3TestUtils.shouldUseSizeRangeFallback(0, null)).toBe(true)
    expect(s3TestUtils.shouldUseSizeRangeFallback(0, { status: 500 })).toBe(true)
  })

  it.concurrent('keeps manifest size lookup failures retrying until the queue budget is exhausted', () => {
    expect(__queueConsumerTestUtils__.getActionableQueueFailures([
      {
        cf_id: 'cf-manifest',
        error_code: 'manifest_size_not_found',
        function_name: 'on_manifest_create',
        function_type: 'supabase',
        msg_id: 10,
        payload_size: 10,
        read_count: MAX_QUEUE_READS - 1,
        status: 503,
        status_text: 'Service Unavailable',
      },
    ])).toEqual([])
  })
  it.concurrent('checkpoints manifest queue deletes without reducing read batch size', () => {
    expect(__queueConsumerTestUtils__.getQueueBatchSize('on_manifest_create', 950)).toBe(950)
    expect(__queueConsumerTestUtils__.getQueueBatchSize('cron_email', 950)).toBe(950)
    expect(__queueConsumerTestUtils__.getQueueBatchSize('on_version_update', 950)).toBe(40)
    expect(__queueConsumerTestUtils__.getQueueAckChunkSize('on_manifest_create')).toBe(100)
    expect(__queueConsumerTestUtils__.getQueueAckChunkSize('cron_email')).toBeNull()
    expect(__queueConsumerTestUtils__.getQueueHttpConcurrency('on_manifest_create')).toBe(100)
    expect(__queueConsumerTestUtils__.getQueueHttpConcurrency('cron_email')).toBe(25)
    expect(__queueConsumerTestUtils__.getQueueHttpConcurrency('on_version_update')).toBe(10)
    expect(__queueConsumerTestUtils__.getQueueVisibilityTimeout('on_manifest_create')).toBe(900)
    expect(__queueConsumerTestUtils__.getQueueVisibilityTimeout('cron_email')).toBe(120)
    expect(__queueConsumerTestUtils__.getQueueVisibilityTimeout('on_version_update')).toBe(900)
    expect(__queueConsumerTestUtils__.getQueueHttpTimeoutMs('on_version_update')).toBe(300_000)
    expect(__queueConsumerTestUtils__.getQueueMaxReads('on_version_update')).toBe(30)
    expect(__queueConsumerTestUtils__.getQueueMaxReads('on_manifest_create')).toBe(5)
    expect(__queueConsumerTestUtils__.getQueueHttpTimeoutMs('cron_email')).toBe(15_000)
    expect(__queueConsumerTestUtils__.shouldRunQueueSyncInBackground('on_manifest_create')).toBe(false)
    expect(__queueConsumerTestUtils__.shouldRunQueueSyncInBackground('cron_email')).toBe(true)
  })

  it.concurrent('accepts legacy supabase function_type in queue message schema', () => {
    const [message] = parseSchema(messagesArraySchema, [
      {
        msg_id: 11,
        read_ct: 0,
        message: {
          function_name: 'on_version_update',
          function_type: 'supabase',
          payload: { table: 'app_versions', type: 'UPDATE' },
        },
      },
    ])
    expect(message?.message.function_type).toBe('supabase')
    expect(__queueConsumerTestUtils__.normalizeQueueFunctionType(message?.message.function_type)).toBe('cloudflare')
  })

  it.concurrent('routes omitted and legacy supabase function types to cloudflare', () => {
    expect(__queueConsumerTestUtils__.normalizeQueueFunctionType(null)).toBe('cloudflare')
    expect(__queueConsumerTestUtils__.normalizeQueueFunctionType(undefined)).toBe('cloudflare')
    expect(__queueConsumerTestUtils__.normalizeQueueFunctionType('')).toBe('cloudflare')
    expect(__queueConsumerTestUtils__.normalizeQueueFunctionType('supabase')).toBe('cloudflare')
    expect(__queueConsumerTestUtils__.normalizeQueueFunctionType('cloudflare')).toBe('cloudflare')
    expect(__queueConsumerTestUtils__.normalizeQueueFunctionType('cloudflare_pp')).toBe('cloudflare_pp')
  })

  it.concurrent('strips app version manifest payloads before HTTP dispatch', () => {
    const body = {
      record: {
        id: 1,
        manifest: [{ file_name: 'index.html' }, { file_name: 'app.js' }],
        r2_path: 'orgs/x/apps/y/1.0.0.zip',
      },
      old_record: {
        id: 1,
        manifest: [{ file_name: 'old.html' }],
        r2_path: null,
      },
      table: 'app_versions',
      type: 'UPDATE',
    }

    expect(__queueConsumerTestUtils__.prepareQueueHttpBody('on_version_update', body)).toEqual({
      ...body,
      record: { ...body.record, manifest: null },
      old_record: { ...body.old_record, manifest: null },
    })
    expect(__queueConsumerTestUtils__.prepareQueueHttpBody('cron_email', body)).toEqual(body)
  })

  it.concurrent('does not reprocess manifests for already deleted versions', () => {
    const deletedAt = '2026-07-07T00:40:00.096Z'
    const appVersionRow = (value: Record<string, unknown>) => value as Parameters<typeof onVersionUpdateTestUtils.getDeletedVersionAction>[0]

    expect(onVersionUpdateTestUtils.getDeletedVersionAction(
      appVersionRow({ deleted_at: deletedAt, manifest: [{ file_name: 'index.html' }], manifest_count: 1 }),
      appVersionRow({ deleted_at: deletedAt }),
    )).toBe('cleanup_manifest')
    expect(onVersionUpdateTestUtils.getDeletedVersionAction(
      appVersionRow({ deleted_at: deletedAt, manifest: null, manifest_count: 0 }),
      appVersionRow({ deleted_at: deletedAt }),
    )).toBe('skip')
    expect(onVersionUpdateTestUtils.getDeletedVersionAction(
      appVersionRow({ deleted_at: deletedAt, manifest: null, manifest_count: 0 }),
      appVersionRow({ deleted_at: null }),
    )).toBe('delete')
    expect(onVersionUpdateTestUtils.getDeletedVersionAction(
      appVersionRow({ deleted_at: null, manifest: [{ file_name: 'index.html' }], manifest_count: 0 }),
      appVersionRow({ deleted_at: null }),
    )).toBe('continue')
  })

  it.concurrent('uses the version queue retry budget for Discord failure alerts', () => {
    const versionRetryBudget = __queueConsumerTestUtils__.getQueueMaxReads('on_version_update')
    const midRetry = {
      cf_id: 'cf-version-mid',
      error_code: 'manifest_cleanup_incomplete',
      function_name: 'on_version_update',
      function_type: 'supabase',
      msg_id: 2,
      payload_size: 10,
      read_count: MAX_QUEUE_READS,
      status: 500,
      status_text: 'Internal Server Error',
    }
    const exhausted = {
      ...midRetry,
      cf_id: 'cf-version-done',
      msg_id: 3,
      read_count: versionRetryBudget,
    }

    expect(versionRetryBudget).toBe(30)
    expect(__queueConsumerTestUtils__.getActionableQueueFailures([midRetry], versionRetryBudget)).toEqual([])
    expect(__queueConsumerTestUtils__.getActionableQueueFailures([exhausted], versionRetryBudget)).toEqual([exhausted])
  })

  it.concurrent('alerts Discord after retry budget is exhausted', () => {
    const failure = {
      cf_id: 'cf-1',
      error_code: 'internal_error',
      function_name: 'on_version_update',
      function_type: 'supabase',
      msg_id: 1,
      payload_size: 10,
      read_count: MAX_QUEUE_READS,
      status: 500,
      status_text: 'Internal Server Error',
    }

    expect(__queueConsumerTestUtils__.getActionableQueueFailures([failure])).toEqual([failure])
  })

  it.concurrent('keeps ignored queue errors out of Discord after retries are exhausted', () => {
    expect(__queueConsumerTestUtils__.getActionableQueueFailures([
      {
        cf_id: 'cf-1',
        error_code: 'version_not_found',
        function_name: 'on_version_update',
        function_type: 'supabase',
        msg_id: 1,
        payload_size: 10,
        read_count: MAX_QUEUE_READS,
        status: 400,
        status_text: 'Bad Request',
      },
    ])).toEqual([])
  })

  it.concurrent('redacts sensitive data before queue failures are sent to Discord', () => {
    const sanitized = __queueConsumerTestUtils__.sanitizeDiscordResponseBody(JSON.stringify({
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz1234567890',
      email: 'alice@capgo.app',
      stack: 'Error: builder unavailable',
      token: 'super-secret-token-value',
      traceId: 'ABCDEF0123456789ABCDEF0123456789',
    }))

    expect(sanitized).toContain('[REDACTED_EMAIL]')
    expect(sanitized).toContain('[REDACTED_TOKEN]')
    expect(sanitized).toContain('[REDACTED]')
    expect(sanitized).not.toContain('alice@capgo.app')
    expect(sanitized).not.toContain('super-secret-token-value')
    expect(sanitized).toContain('builder unavailable')
  })

  it.concurrent('keeps message-only JSON error details actionable', async () => {
    const response = new Response(JSON.stringify({
      message: 'builder unavailable',
    }), {
      headers: {
        'content-type': 'application/json',
      },
      status: 503,
      statusText: 'Service Unavailable',
    })

    await expect(__queueConsumerTestUtils__.extractErrorDetails(response)).resolves.toEqual({
      bodyPreview: '{"message":"builder unavailable"}',
      errorCode: null,
      errorMessage: 'builder unavailable',
    })
  })

  it.concurrent('turns queue transport failures into retryable per-message responses', async () => {
    const response = __queueConsumerTestUtils__.queueFailureResponse('queue_message_failed', 'fetch failed', {
      cfId: 'cf-transport',
      msgId: 12,
      queueName: 'on_manifest_create',
      targetUrl: 'direct:on_manifest_create',
    })

    const details = await __queueConsumerTestUtils__.extractErrorDetails(response)

    expect(response.status).toBe(599)
    expect(details.errorCode).toBe('queue_message_failed')
    expect(details.errorMessage).toBe('fetch failed')
    expect(details.bodyPreview).toContain('"queueName":"on_manifest_create"')
    expect(details.bodyPreview).toContain('"targetUrl":"direct:on_manifest_create"')
  })

  it.concurrent('preserves direct handler HTTP error details for queue retries', async () => {
    const response = __queueConsumerTestUtils__.httpExceptionToQueueResponse(new HTTPException(503, {
      message: 'Manifest file size metadata was not found',
      cause: {
        error: 'manifest_size_not_found',
        message: 'Manifest file size metadata was not found',
        moreInfo: {
          id: 123,
          queue: { queueName: 'on_manifest_create' },
        },
      },
    }))

    expect(response).not.toBeNull()
    const details = await __queueConsumerTestUtils__.extractErrorDetails(response!)

    expect(response!.status).toBe(503)
    expect(details.errorCode).toBe('manifest_size_not_found')
    expect(details.errorMessage).toBe('Manifest file size metadata was not found')
    expect(details.bodyPreview).toContain('"id":123')
    expect(details.bodyPreview).toContain('"queueName":"on_manifest_create"')
  })

  it.concurrent('calls the healthcheck URL when the worker succeeds', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const reported = await __queueConsumerTestUtils__.maybePingCronHealthcheck(
      {
        actionableFailureCount: 0,
        archivedCount: 0,
        failedCount: 0,
        processedCount: 1,
        readSucceeded: true,
        skippedCount: 0,
        success: true,
        successCount: 1,
      },
      'https://example.com/healthcheck',
      fetchImpl,
    )

    expect(reported).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/healthcheck', expect.objectContaining({
      method: 'GET',
    }))
  })

  it.concurrent('calls the healthcheck start URL when requested', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const reported = await __queueConsumerTestUtils__.maybePingCronHealthcheckStart(
      'https://example.com/healthcheck/',
      fetchImpl,
    )

    expect(reported).toBe(true)
    expect(__queueConsumerTestUtils__.getCronHealthcheckStartUrl('https://example.com/healthcheck/')).toBe('https://example.com/healthcheck/start')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/healthcheck/start', expect.objectContaining({
      method: 'GET',
    }))
  })

  it.concurrent('calls the healthcheck URL when successful queue work remains', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const reported = await __queueConsumerTestUtils__.maybePingCronHealthcheck(
      {
        actionableFailureCount: 0,
        archivedCount: 0,
        failedCount: 0,
        processedCount: 1,
        readSucceeded: true,
        skippedCount: 0,
        success: true,
        successCount: 1,
      },
      'https://example.com/healthcheck',
      fetchImpl,
    )

    expect(reported).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.concurrent('returns false when the healthcheck URL responds with an error', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch

    const reported = await __queueConsumerTestUtils__.maybePingCronHealthcheck(
      {
        actionableFailureCount: 0,
        archivedCount: 0,
        failedCount: 0,
        processedCount: 1,
        readSucceeded: true,
        skippedCount: 0,
        success: true,
        successCount: 1,
      },
      'https://example.com/healthcheck',
      fetchImpl,
    )

    expect(reported).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.concurrent('calls the healthcheck URL for retryable message failures', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const reported = await __queueConsumerTestUtils__.maybePingCronHealthcheck(
      {
        actionableFailureCount: 0,
        archivedCount: 0,
        failedCount: 1,
        processedCount: 1,
        readSucceeded: true,
        skippedCount: 0,
        success: false,
        successCount: 0,
      },
      'https://example.com/healthcheck',
      fetchImpl,
    )

    expect(reported).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.concurrent('does not call the healthcheck URL when the worker had actionable failures', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch

    const reported = await __queueConsumerTestUtils__.maybePingCronHealthcheck(
      {
        actionableFailureCount: 1,
        archivedCount: 0,
        failedCount: 1,
        processedCount: 1,
        readSucceeded: true,
        skippedCount: 0,
        success: false,
        successCount: 0,
      },
      'https://example.com/healthcheck',
      fetchImpl,
    )

    expect(reported).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
