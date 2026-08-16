import type { Blob, R2HTTPMetadata, R2UploadedPart } from '@cloudflare/workers-types'

// Retries with backoff of [100ms, 200ms, 400ms, 800ms, 1600ms]
export const DEFAULT_RETRY_PARAMS = { maxRetries: 5, durationMillis: 100 }

export interface RetryParameters {
  maxRetries: number
  durationMillis: number
}

export interface RetryOptions {
  params: RetryParameters
  shouldRetry?: (error: unknown) => boolean
  sleepFun?: (ms: number) => Promise<void>
}

// Retry a function with exponential backoff until it succeeds or a maximum number of retries is exceeded
export async function retry<T>(retryableFunc: () => Promise<T>, options: RetryOptions): Promise<T> {
  const shouldRetry = options.shouldRetry || (_error => true)
  const sleeper = options.sleepFun || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  let count = 0
  for (; ;) {
    try {
      return await retryableFunc()
    }
    catch (e) {
      if (count === options.params.maxRetries || !shouldRetry(e)) {
        throw e
      }
      await sleeper(options.params.durationMillis * (2 ** count))
    }
    count++
  }
}

// Check if an error returned by an R2 operation is a checksum mismatch error
export function isR2ChecksumError(error: unknown): boolean {
  // "put: The SHA-256 checksum you specified did not match what we received.
  // You provided a SHA-256 checksum with value: <sha>
  // Actual SHA-256 was: <sha> (10037)"
  return isR2Error(error, msg => msg.includes('sha-256') || msg.includes('10037'))
}

export function isR2MultipartDoesNotExistError(error: unknown): boolean {
  // "uploadPart: The specified multipart upload does not exist. (10024)"
  return isR2Error(error, msg => msg.includes('multipart upload does not exist') || msg.includes('10024'))
}

function isR2Error(error: unknown, predicate: (msg: string) => boolean): boolean {
  // R2 bindings currently has no structured errors :( . We need to check for expected errors
  // by searching error messages. These usually contain a numeric error code, but not always
  if (error != null && error instanceof Object && Object.hasOwn(error, 'message')) {
    const msg: string = (error as { message: string }).message
    return predicate(msg.toLowerCase())
  }
  return false
}

// Wraps R2Bucket operations with retries and exponential backoff
export class RetryBucket {
  bucket: R2Bucket
  params: RetryParameters

  constructor(bucket: R2Bucket, params: RetryParameters) {
    this.bucket = bucket
    this.params = params
  }

  async head(...parameters: Parameters<R2Bucket['head']>): ReturnType<R2Bucket['head']> {
    return retry(() => this.bucket.head(...parameters), { params: this.params })
  }

  async get(...parameters: Parameters<R2Bucket['get']>): ReturnType<R2Bucket['get']> {
    return retry(() => this.bucket.get(...parameters), { params: this.params })
  }

  async delete(...parameters: Parameters<R2Bucket['delete']>): ReturnType<R2Bucket['delete']> {
    return retry(() => this.bucket.delete(...parameters), { params: this.params })
  }

  // don't allow streaming writes so the operation can be safely retried
  async put(
    key: string,
    value: (ArrayBuffer | ArrayBufferView) | string | Blob,
    checksum?: string | ArrayBuffer,
    httpMetadata?: R2HTTPMetadata,
  ): ReturnType<R2Bucket['put']> {
    return retry(
      () => this.bucket.put(key, value as any, { sha256: checksum, httpMetadata }),
      {
        params: this.params,
        shouldRetry: error => !isR2ChecksumError(error),
      },
    )
  }

  async createMultipartUpload(...parameters: Parameters<R2Bucket['createMultipartUpload']>): Promise<RetryMultipartUpload> {
    return new RetryMultipartUpload(await this.bucket.createMultipartUpload(...parameters), this.params)
  }

  resumeMultipartUpload(...parameters: Parameters<R2Bucket['resumeMultipartUpload']>): RetryMultipartUpload {
    return new RetryMultipartUpload(this.bucket.resumeMultipartUpload(...parameters), this.params)
  }
}

export class RetryMultipartUpload {
  r2MultipartUpload: R2MultipartUpload
  params: RetryParameters

  constructor(r2MultipartUpload: R2MultipartUpload, params: RetryParameters) {
    this.r2MultipartUpload = r2MultipartUpload
    this.params = params
  }

  // don't allow streaming writes so the operation can be safely retried
  async uploadPart(partNumber: number, value: (ArrayBuffer | ArrayBufferView) | string | Blob): Promise<R2UploadedPart> {
    return retry(() => this.r2MultipartUpload.uploadPart(partNumber, value as any), this.retryOptions())
  }

  async abort(): ReturnType<R2MultipartUpload['abort']> {
    // No need to retry aborts, the transactional will eventually be cleaned up anyway
    return this.r2MultipartUpload.abort()
  }

  async complete(...parameters: Parameters<R2MultipartUpload['complete']>): ReturnType<R2MultipartUpload['complete']> {
    return retry(() => this.r2MultipartUpload.complete(...parameters), this.retryOptions())
  }

  retryOptions(): RetryOptions {
    return {
      shouldRetry: error => !isR2MultipartDoesNotExistError(error),
      params: this.params,
    }
  }
}
