import { describe, expect, it } from 'bun:test'
import {
  ManifestUploadAbandonController,
  ManifestUploadAbandonError,
  getManifestUploadAbandonError,
  parseManifestUploadAbandonBody,
  resolveManifestUploadAbandonScope,
} from '../../src/bundle/upload-abandon-error'

function detailedError(body: string): unknown {
  return {
    originalResponse: {
      getBody: () => body,
    },
  }
}

describe('manifest upload explicit abandon responses', () => {
  it('parses a full-upload abandon response and preserves the complete message', () => {
    const backendMessage = `Contact Capgo support. ${'x'.repeat(4_096)}`
    const error = getManifestUploadAbandonError(detailedError(JSON.stringify({
      abandon_explicit_error: backendMessage,
      moreInfo: { requestId: 'request-123' },
    })))

    expect(error).toBeInstanceOf(ManifestUploadAbandonError)
    expect(error?.scope).toBe('all')
    expect(error?.backendMessage).toBe(backendMessage)
    expect(error?.requestId).toBe('request-123')
    expect(error?.message).toContain(backendMessage)
  })

  it('parses a manifest-only abandon response', () => {
    const error = parseManifestUploadAbandonBody(JSON.stringify({
      abandon_manifest_only_explicit_error: 'Manifest upload expired; continuing with ZIP only.',
    }))

    expect(error?.scope).toBe('manifest')
    expect(error?.backendMessage).toBe('Manifest upload expired; continuing with ZIP only.')
  })

  it('uses the safer full-upload abandon when both response fields are present', () => {
    const error = parseManifestUploadAbandonBody(JSON.stringify({
      abandon_explicit_error: 'Stop everything.',
      abandon_manifest_only_explicit_error: 'Continue with ZIP.',
    }))

    expect(error?.scope).toBe('all')
    expect(error?.backendMessage).toBe('Stop everything.')
  })

  it('ignores malformed JSON and non-string abandon fields', () => {
    expect(parseManifestUploadAbandonBody('<html>bad gateway</html>')).toBeUndefined()
    expect(parseManifestUploadAbandonBody(JSON.stringify({ abandon_explicit_error: 42 }))).toBeUndefined()
    expect(getManifestUploadAbandonError(new Error('ordinary failure'))).toBeUndefined()
  })

  it('removes terminal control characters without truncating the message', () => {
    const error = parseManifestUploadAbandonBody(JSON.stringify({
      abandon_explicit_error: 'before\u001B[31mafter',
    }))

    expect(error?.backendMessage).toBe('before[31mafter')
  })

  it('allows manifest-only fallback only when manifest upload was auto-enabled with ZIP fallback', () => {
    const error = new ManifestUploadAbandonError('manifest', 'Manifest upload expired.')

    expect(resolveManifestUploadAbandonScope(error, true)).toBe('manifest')
    expect(resolveManifestUploadAbandonScope(error, false)).toBe('all')
  })
})

describe('ManifestUploadAbandonController', () => {
  it('aborts and rejects every active manifest upload with the same error', async () => {
    const controller = new ManifestUploadAbandonController()
    const aborts: string[] = []
    const rejections: unknown[] = []
    const firstUpload = { abort: async () => { aborts.push('first') } }
    const secondUpload = { abort: async () => { aborts.push('second') } }

    expect(controller.register(firstUpload, error => rejections.push(error))).toBe(true)
    expect(controller.register(secondUpload, error => rejections.push(error))).toBe(true)

    const abandonError = new ManifestUploadAbandonError('all', 'Authorization rejected.')
    await controller.abandon(abandonError)

    expect(aborts.sort()).toEqual(['first', 'second'])
    expect(rejections).toEqual([abandonError, abandonError])
    expect(() => controller.throwIfAbandoned()).toThrow(abandonError)
  })

  it('rejects uploads registered after abandonment without starting them', async () => {
    const controller = new ManifestUploadAbandonController()
    const abandonError = new ManifestUploadAbandonError('manifest', 'Manifest upload expired.')
    await controller.abandon(abandonError)

    let rejection: unknown
    const registered = controller.register(
      { abort: async () => { throw new Error('must not abort an upload that never started') } },
      error => { rejection = error },
    )

    expect(registered).toBe(false)
    expect(rejection).toBe(abandonError)
  })

  it('rejects every upload even when one TUS abort operation fails', async () => {
    const controller = new ManifestUploadAbandonController()
    const rejections: unknown[] = []
    controller.register(
      { abort: async () => { throw new Error('abort failed') } },
      error => rejections.push(error),
    )
    controller.register(
      { abort: async () => {} },
      error => rejections.push(error),
    )

    const abandonError = new ManifestUploadAbandonError('all', 'Authorization rejected.')
    await controller.abandon(abandonError)

    expect(rejections).toEqual([abandonError, abandonError])
  })
})
