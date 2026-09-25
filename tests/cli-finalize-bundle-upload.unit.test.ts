import type { UploadReporter, UploadSpinner } from '../cli/src/bundle/reporter'
import { describe, expect, it, vi } from 'vitest'
import { finalizeUploadedBundle } from '../cli/src/bundle/finalize-upload'
import { CliUserError } from '../cli/src/shared/cli-user-error'

function createReporter() {
  const spinner: UploadSpinner = {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  }
  const reporter: UploadReporter = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: () => spinner,
  }
  return { reporter, spinner }
}

describe('bundle upload finalization', () => {
  it('keeps the legacy update when the target API does not advertise support', async () => {
    const { reporter } = createReporter()
    const legacyFinalize = vi.fn(async () => {})
    const invoke = vi.fn(async () => ({ data: {}, error: null }))

    await finalizeUploadedBundle({
      apikey: 'test-key',
      appId: 'com.example.app',
      bundle: '1.2.3',
      reporter,
    }, legacyFinalize, {
      invoke,
      formatError: vi.fn(),
    })

    expect(legacyFinalize).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('calls the finalize endpoint with a spinner', async () => {
    const { reporter, spinner } = createReporter()
    const invoke = vi.fn(async (path: string) => ({
      data: path === 'private/config' ? { useNewFinalizeBundleUpload: true } : { status: 'ok' },
      error: null,
    }))

    await finalizeUploadedBundle({
      apikey: 'test-key',
      appId: 'com.example.app',
      bundle: '1.2.3',
      supaHost: 'http://localhost:54321',
      supaAnon: 'anon-key',
      reporter,
    }, vi.fn(), {
      invoke,
      formatError: vi.fn(),
    })

    expect(invoke).toHaveBeenNthCalledWith(1, 'private/config', {
      apikey: 'test-key',
      method: 'GET',
      supaHost: 'http://localhost:54321',
      supaAnon: 'anon-key',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'private/finalize_bundle_upload', {
      apikey: 'test-key',
      body: { app_id: 'com.example.app', name: '1.2.3' },
      supaHost: 'http://localhost:54321',
      supaAnon: 'anon-key',
    })
    expect(spinner.start).toHaveBeenCalledWith('Finalizing bundle upload...')
    expect(spinner.stop).toHaveBeenCalledWith('Bundle upload finalized')
  })

  it('shows the backend error when finalization fails', async () => {
    const { reporter, spinner } = createReporter()
    const backendError = new Error('request failed')

    const promise = finalizeUploadedBundle({
      apikey: 'test-key',
      appId: 'com.example.app',
      bundle: '1.2.3',
      reporter,
    }, vi.fn(), {
      invoke: vi.fn(async (path: string) => path === 'private/config'
        ? { data: { useNewFinalizeBundleUpload: true }, error: null }
        : { data: null, error: backendError }),
      formatError: vi.fn(async () => 'Version upload is already deleted'),
    })

    await expect(promise).rejects.toEqual(new CliUserError('Cannot finalize bundle upload: Version upload is already deleted'))
    expect(spinner.error).toHaveBeenCalledWith('Cannot finalize bundle upload: Version upload is already deleted')
    expect(spinner.stop).not.toHaveBeenCalled()
  })
})
