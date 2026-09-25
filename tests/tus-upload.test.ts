import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ORG_SUPER_ADMIN,
  getEndpointUrl,
  ORG_ID,
  resetAndSeedAppData,
  resetAppData,
} from './test-utils'

// TUS protocol constants
const TUS_VERSION = '1.0.0'
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'
const cloudflareIt = USE_CLOUDFLARE ? it.concurrent : it.skip
const localIt = USE_CLOUDFLARE ? it.skip : it.concurrent

/**
 * Helper to create a TUS upload via the Capgo API (goes through middleware)
 */
async function createTusUploadViaApi(
  appId: string,
  filename: string,
  uploadLength: number,
): Promise<{ uploadUrl: string, response: Response }> {
  const filePath = `orgs/${ORG_ID}/apps/${appId}/${filename}`
  const filenameB64 = btoa(filePath)

  const response = await fetch(getEndpointUrl('/files/upload/attachments'), {
    method: 'POST',
    headers: {
      'Authorization': APIKEY_TEST_ORG_SUPER_ADMIN,
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': uploadLength.toString(),
      'Upload-Metadata': `filename ${filenameB64}`,
      'Content-Type': 'application/offset+octet-stream',
    },
  })

  const location = response.headers.get('Location')
  return {
    uploadUrl: location ?? '',
    response,
  }
}

/**
 * Helper to upload a chunk via TUS PATCH
 */
async function uploadChunk(
  uploadUrl: string,
  data: Uint8Array,
  offset: number,
): Promise<Response> {
  return fetch(uploadUrl, {
    method: 'PATCH',
    headers: {
      'Authorization': APIKEY_TEST_ORG_SUPER_ADMIN,
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': offset.toString(),
      'Content-Type': 'application/offset+octet-stream',
    },
    body: data as unknown as BodyInit,
  })
}

/**
 * Helper to check upload progress via TUS HEAD
 */
async function checkUploadProgress(uploadUrl: string): Promise<{
  offset: number
  length: number | null
  response: Response
}> {
  const response = await fetch(uploadUrl, {
    method: 'HEAD',
    headers: {
      'Authorization': APIKEY_TEST_ORG_SUPER_ADMIN,
      'Tus-Resumable': TUS_VERSION,
    },
  })

  return {
    offset: Number.parseInt(response.headers.get('Upload-Offset') ?? '0'),
    length: response.headers.get('Upload-Length')
      ? Number.parseInt(response.headers.get('Upload-Length')!)
      : null,
    response,
  }
}

/**
 * Generate test data of specified size
 */
function generateTestData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = i % 256
  }
  return data
}

describe('tus upload protocol tests', () => {
  const id = randomUUID().substring(0, 8)
  const APPNAME = `com.tus.test.${id}`

  beforeAll(async () => {
    await resetAndSeedAppData(APPNAME)
  })

  afterAll(async () => {
    await resetAppData(APPNAME)
  })

  describe('tus config endpoint', () => {
    it('should return TUSUpload: true for self-hosted', async () => {
      const response = await fetch(getEndpointUrl('/files/config'))
      expect(response.status).toBe(200)

      const config = await response.json() as { TUSUpload: boolean, maxUploadLength: number }
      expect(config.TUSUpload).toBe(true)
      expect(config.maxUploadLength).toBeGreaterThan(0)
    })
  })

  describe('options - tus discovery', () => {
    it('should return TUS capabilities on OPTIONS request', async () => {
      const response = await fetch(getEndpointUrl('/files/upload/attachments'), {
        method: 'OPTIONS',
      })

      expect(response.status).toBe(204)
      expect(response.headers.get('Tus-Resumable')).toBe(TUS_VERSION)
      expect(response.headers.get('Tus-Version')).toBe(TUS_VERSION)
      expect(response.headers.get('Tus-Extension')).toContain('creation')
    })
  })

  describe('build upload options - tus discovery', () => {
    it('should return TUS capabilities for /build/upload/:jobId', async () => {
      const response = await fetch(getEndpointUrl('/build/upload/test-job'), {
        method: 'OPTIONS',
      })

      expect(response.status).toBe(204)
      expect(response.headers.get('Tus-Resumable')).toBe(TUS_VERSION)
      expect(response.headers.get('Tus-Version')).toBe(TUS_VERSION)
      expect(response.headers.get('Tus-Extension')).toContain('creation')
    })

    it('should return TUS capabilities for /build/upload/:jobId/*', async () => {
      const response = await fetch(getEndpointUrl('/build/upload/test-job/any-file.zip'), {
        method: 'OPTIONS',
      })

      expect(response.status).toBe(204)
      expect(response.headers.get('Tus-Resumable')).toBe(TUS_VERSION)
      expect(response.headers.get('Tus-Version')).toBe(TUS_VERSION)
      expect(response.headers.get('Tus-Extension')).toContain('creation')
    })
  })

  describe('post - create upload', () => {
    it('should create upload with valid metadata', async () => {
      const { response, uploadUrl } = await createTusUploadViaApi(
        APPNAME,
        `test-create-${Date.now()}.zip`,
        1024,
      )

      expect(response.status).toBe(201)
      expect(uploadUrl).toBeTruthy()
      expect(response.headers.get('Tus-Resumable')).toBe(TUS_VERSION)
    })

    it('should reject without authentication', async () => {
      const filePath = `orgs/${ORG_ID}/apps/${APPNAME}/test.zip`
      const filenameB64 = btoa(filePath)

      const response = await fetch(getEndpointUrl('/files/upload/attachments'), {
        method: 'POST',
        headers: {
          'Tus-Resumable': TUS_VERSION,
          'Upload-Length': '1024',
          'Upload-Metadata': `filename ${filenameB64}`,
        },
      })

      // Should fail with 400 (missing auth) or 401
      expect([400, 401]).toContain(response.status)
    })
  })

  describe('patch - upload chunks', () => {
    it('should upload single chunk successfully', async () => {
      const testData = generateTestData(1024)

      // Create upload
      const { uploadUrl, response: createResponse } = await createTusUploadViaApi(
        APPNAME,
        `test-single-chunk-${Date.now()}.zip`,
        testData.length,
      )
      expect(createResponse.status).toBe(201)
      expect(uploadUrl).toBeTruthy()

      // Upload chunk
      const patchResponse = await uploadChunk(uploadUrl, testData, 0)
      expect(patchResponse.status).toBe(204)
      expect(patchResponse.headers.get('Upload-Offset')).toBe(testData.length.toString())
    })

    it('should upload multiple chunks sequentially', async () => {
      const chunkSize = 512
      const totalSize = chunkSize * 3 // 1536 bytes total
      const testData = generateTestData(totalSize)

      // Create upload
      const { uploadUrl, response: createResponse } = await createTusUploadViaApi(
        APPNAME,
        `test-multi-chunk-${Date.now()}.zip`,
        totalSize,
      )
      expect(createResponse.status).toBe(201)

      // Upload chunks
      for (let offset = 0; offset < totalSize; offset += chunkSize) {
        const chunk = testData.slice(offset, offset + chunkSize)
        const patchResponse = await uploadChunk(uploadUrl, chunk, offset)
        expect(patchResponse.status).toBe(204)
        expect(patchResponse.headers.get('Upload-Offset')).toBe((offset + chunk.length).toString())
      }
    })
  })

  describe('head - check progress', () => {
    it('should return current offset after partial upload', async () => {
      const totalSize = 2048
      const firstChunkSize = 1024
      const testData = generateTestData(totalSize)

      // Create upload
      const { uploadUrl, response: createResponse } = await createTusUploadViaApi(
        APPNAME,
        `test-head-progress-${Date.now()}.zip`,
        totalSize,
      )
      expect(createResponse.status).toBe(201)

      // Upload first chunk
      const firstChunk = testData.slice(0, firstChunkSize)
      await uploadChunk(uploadUrl, firstChunk, 0)

      // Check progress
      const { offset, length, response: headResponse } = await checkUploadProgress(uploadUrl)
      expect(headResponse.status).toBe(200)
      expect(offset).toBe(firstChunkSize)
      expect(length).toBe(totalSize)
    })
  })

  describe('resumable upload scenarios', () => {
    it('should resume upload after partial completion', async () => {
      const totalSize = 3072 // 3KB
      const chunkSize = 1024 // 1KB chunks
      const testData = generateTestData(totalSize)

      // Create upload
      const { uploadUrl, response: createResponse } = await createTusUploadViaApi(
        APPNAME,
        `test-resume-${Date.now()}.zip`,
        totalSize,
      )
      expect(createResponse.status).toBe(201)

      // Upload first chunk
      const firstChunk = testData.slice(0, chunkSize)
      await uploadChunk(uploadUrl, firstChunk, 0)

      // Simulate "disconnect" - just check progress
      const { offset: progressAfterFirst } = await checkUploadProgress(uploadUrl)
      expect(progressAfterFirst).toBe(chunkSize)

      // Resume: upload second chunk
      const secondChunk = testData.slice(chunkSize, chunkSize * 2)
      await uploadChunk(uploadUrl, secondChunk, chunkSize)

      // Check progress
      const { offset: progressAfterSecond } = await checkUploadProgress(uploadUrl)
      expect(progressAfterSecond).toBe(chunkSize * 2)

      // Complete: upload third chunk
      const thirdChunk = testData.slice(chunkSize * 2, chunkSize * 3)
      await uploadChunk(uploadUrl, thirdChunk, chunkSize * 2)

      // Verify complete
      const { offset: finalOffset } = await checkUploadProgress(uploadUrl)
      expect(finalOffset).toBe(totalSize)
    })
  })

  describe('error handling', () => {
    cloudflareIt('should accept upload filenames containing literal percent signs without returning malformed URLs', async () => {
      const { response, uploadUrl } = await createTusUploadViaApi(
        APPNAME,
        `test-percent-${Date.now()}-100%.zip`,
        1024,
      )

      expect(response.status).toBe(201)
      expect(uploadUrl).not.toBe('')
      expect(uploadUrl).not.toMatch(/%(?![0-9A-Fa-f]{2})/)
    })

    cloudflareIt('should accept upload filenames containing percent-like sequences without returning malformed URLs', async () => {
      const { response, uploadUrl } = await createTusUploadViaApi(
        APPNAME,
        `test-percent-${Date.now()}-%zz.zip`,
        1024,
      )

      expect(response.status).toBe(201)
      expect(uploadUrl).not.toBe('')
      expect(uploadUrl).not.toMatch(/%(?![0-9A-Fa-f]{2})/)
    })

    cloudflareIt('should reject read paths containing malformed percent encoding with a client error body', async () => {
      const response = await fetch(getEndpointUrl(`/files/read/attachments/orgs/${ORG_ID}/apps/${APPNAME}/test-%zz.zip`))

      expect(response.status).toBe(400)
      const body = await response.json() as { error?: string }
      expect(body.error).toBe('invalid_file_path_encoding')
    })

    cloudflareIt('should reject malformed read paths before an embedded attachment route prefix', async () => {
      const response = await fetch(getEndpointUrl(`/files/read/attachments/orgs/${ORG_ID}/apps/${APPNAME}/test-%zz/files/upload/attachments/ok.zip`))

      expect(response.status).toBe(400)
      const body = await response.json() as { error?: string }
      expect(body.error).toBe('invalid_file_path_encoding')
    })

    localIt('should reject read paths containing malformed percent encoding without a server error', async () => {
      const response = await fetch(getEndpointUrl(`/files/read/attachments/orgs/${ORG_ID}/apps/${APPNAME}/test-%zz.zip`))

      expect(response.status).toBe(400)
    })

    it('should reject upload without Upload-Length header', async () => {
      const filePath = `orgs/${ORG_ID}/apps/${APPNAME}/test.zip`
      const filenameB64 = btoa(filePath)

      const response = await fetch(getEndpointUrl('/files/upload/attachments'), {
        method: 'POST',
        headers: {
          'Authorization': APIKEY_TEST_ORG_SUPER_ADMIN,
          'Tus-Resumable': TUS_VERSION,
          'Upload-Metadata': `filename ${filenameB64}`,
        },
      })

      // Should fail with 400 (bad request)
      expect(response.status).toBe(400)
    })

    it('should reject upload to non-existent app', async () => {
      const filePath = `orgs/${ORG_ID}/apps/com.nonexistent.app/test.zip`
      const filenameB64 = btoa(filePath)

      const response = await fetch(getEndpointUrl('/files/upload/attachments'), {
        method: 'POST',
        headers: {
          'Authorization': APIKEY_TEST_ORG_SUPER_ADMIN,
          'Tus-Resumable': TUS_VERSION,
          'Upload-Length': '1024',
          'Upload-Metadata': `filename ${filenameB64}`,
        },
      })

      // Should fail with 403 (insufficient permissions) - API doesn't reveal if app exists
      expect(response.status).toBe(403)
    })

    it('should reject upload with invalid path structure', async () => {
      const filePath = `invalid/path/test.zip`
      const filenameB64 = btoa(filePath)

      const response = await fetch(getEndpointUrl('/files/upload/attachments'), {
        method: 'POST',
        headers: {
          'Authorization': APIKEY_TEST_ORG_SUPER_ADMIN,
          'Tus-Resumable': TUS_VERSION,
          'Upload-Length': '1024',
          'Upload-Metadata': `filename ${filenameB64}`,
        },
      })

      // Should fail with 400 (invalid path)
      expect(response.status).toBe(400)
    })
  })
})
