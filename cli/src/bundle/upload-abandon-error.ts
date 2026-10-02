import { CliUserError } from '../shared/cli-user-error'

export type ManifestUploadAbandonScope = 'all' | 'manifest'

interface AbortableManifestUpload {
  abort: (shouldTerminate?: boolean) => Promise<void> | void
}

type RejectUpload = (reason: unknown) => void

function stripTerminalControlCharacters(value: string): string {
  return Array.from(value).filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === 9
      || codePoint === 10
      || (codePoint >= 32 && !(codePoint >= 127 && codePoint <= 159))
  }).join('')
}

export class ManifestUploadAbandonError extends CliUserError {
  readonly backendMessage: string
  readonly requestId?: string
  readonly scope: ManifestUploadAbandonScope

  constructor(scope: ManifestUploadAbandonScope, backendMessage: string, requestId?: string) {
    const safeMessage = stripTerminalControlCharacters(backendMessage)
    const safeRequestId = requestId === undefined ? undefined : stripTerminalControlCharacters(requestId)
    const requestIdSuffix = safeRequestId ? ` Request ID: ${safeRequestId}` : ''
    super(`Abandoning manifest upload. The following error occurred: ${safeMessage}${requestIdSuffix}`)
    this.name = 'ManifestUploadAbandonError'
    this.backendMessage = safeMessage
    this.requestId = safeRequestId
    this.scope = scope
  }
}

export function parseManifestUploadAbandonBody(body: string | undefined): ManifestUploadAbandonError | undefined {
  if (body === undefined)
    return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return undefined
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined

  const response = parsed as Record<string, unknown>
  const moreInfo = response.moreInfo && typeof response.moreInfo === 'object' && !Array.isArray(response.moreInfo)
    ? response.moreInfo as Record<string, unknown>
    : undefined
  const requestId = typeof moreInfo?.requestId === 'string'
    ? moreInfo.requestId
    : typeof response.requestId === 'string'
      ? response.requestId
      : undefined

  if (typeof response.abandon_explicit_error === 'string')
    return new ManifestUploadAbandonError('all', response.abandon_explicit_error, requestId)

  if (typeof response.abandon_manifest_only_explicit_error === 'string')
    return new ManifestUploadAbandonError('manifest', response.abandon_manifest_only_explicit_error, requestId)

  return undefined
}

export function getManifestUploadAbandonError(error: unknown): ManifestUploadAbandonError | undefined {
  const detailedError = error as { originalResponse?: { getBody?: () => string } }
  return parseManifestUploadAbandonBody(detailedError?.originalResponse?.getBody?.())
}

export function resolveManifestUploadAbandonScope(error: ManifestUploadAbandonError, manifestUploadAutoEnabled: boolean): ManifestUploadAbandonScope {
  return error.scope === 'manifest' && manifestUploadAutoEnabled ? 'manifest' : 'all'
}

export class ManifestUploadAbandonController {
  private abandonError: ManifestUploadAbandonError | undefined
  private abandonPromise: Promise<void> | undefined
  private readonly activeUploads = new Map<AbortableManifestUpload, RejectUpload>()

  register(upload: AbortableManifestUpload, reject: RejectUpload): boolean {
    if (this.abandonError) {
      reject(this.abandonError)
      return false
    }

    this.activeUploads.set(upload, reject)
    return true
  }

  unregister(upload: AbortableManifestUpload): void {
    this.activeUploads.delete(upload)
  }

  throwIfAbandoned(): void {
    if (this.abandonError)
      throw this.abandonError
  }

  async abandon(error: ManifestUploadAbandonError): Promise<void> {
    if (!this.abandonError)
      this.abandonError = error

    if (!this.abandonPromise) {
      const activeUploads = [...this.activeUploads.entries()]
      this.activeUploads.clear()
      this.abandonPromise = (async () => {
        await Promise.allSettled(activeUploads.map(([upload]) => Promise.resolve(upload.abort())))
        for (const [, reject] of activeUploads)
          reject(this.abandonError)
      })()
    }

    await this.abandonPromise
  }
}
