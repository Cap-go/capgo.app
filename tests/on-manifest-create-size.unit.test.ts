import { describe, expect, it } from 'vitest'
import { onManifestCreateTestUtils } from '../supabase/functions/_backend/triggers/on_manifest_create.ts'
import { __queueConsumerTestUtils__ } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import { s3TestUtils, type StorageSizeDiagnostics } from '../supabase/functions/_backend/utils/s3.ts'

function missingDiagnostics(): StorageSizeDiagnostics {
  return {
    bucket: 'capgo',
    candidateKeys: ['path/file.js'],
    candidates: [{
      fileId: 'path/file.js',
      finalSize: 0,
      head: { error: { status: 404, message: 'not found', name: 'Error', stack: undefined, cause: undefined }, size: 0, success: false },
      usedFallback: false,
    }],
    endpoint: 'https://example.invalid/',
    fileId: 'path/file.js',
    selectedCandidateKey: null,
    size: 0,
  }
}

function transientDiagnostics(): StorageSizeDiagnostics {
  return {
    bucket: 'capgo',
    candidateKeys: ['path/file.js'],
    candidates: [{
      fileId: 'path/file.js',
      finalSize: 0,
      head: { rawSize: 0, size: 0, success: true },
      range: { reason: 'missing_head_size', size: 0, status: 200, statusText: 'OK' },
      usedFallback: true,
    }],
    endpoint: 'https://example.invalid/',
    fileId: 'path/file.js',
    selectedCandidateKey: null,
    size: 0,
  }
}

describe('on_manifest_create size lookup', () => {
  it.concurrent('retries R2 size reads a few times inside one queue attempt', () => {
    expect(onManifestCreateTestUtils.sizeRetryAttempts).toBe(4)
  })

  it.concurrent('treats definitive storage 404 as terminal missing object', () => {
    expect(s3TestUtils.isManifestStorageObjectDefinitelyMissing(missingDiagnostics())).toBe(true)
    expect(s3TestUtils.isManifestStorageObjectDefinitelyMissing(transientDiagnostics())).toBe(false)
    expect(s3TestUtils.isManifestStorageObjectDefinitelyMissing({
      ...missingDiagnostics(),
      size: 12,
    })).toBe(false)
  })

  it.concurrent('acks only successful manifest queue messages inside a chunk', () => {
    const ok = new Response('ok', { status: 200 })
    const retry = new Response(JSON.stringify({ error: 'manifest_size_not_found' }), { status: 503 })
    const chunk = [
      { httpResponse: ok, msg_id: 1 },
      { httpResponse: retry, msg_id: 2 },
      { httpResponse: ok, msg_id: 3 },
    ]
    const { successful, failed } = __queueConsumerTestUtils__.partitionQueueResultsForAck(chunk)
    expect(successful.map(row => row.msg_id)).toEqual([1, 3])
    expect(failed.map(row => row.msg_id)).toEqual([2])
    expect(__queueConsumerTestUtils__.isSuccessfulQueueResult(chunk[0]!)).toBe(true)
    expect(__queueConsumerTestUtils__.isSuccessfulQueueResult(chunk[1]!)).toBe(false)
  })
})
