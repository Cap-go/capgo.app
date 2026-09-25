import type { UploadReporter } from './reporter'
import { CliUserError } from '../shared/cli-user-error'
import { formatCapgoCliInvokeError, invokeCapgoCliApi } from '../utils'

interface FinalizeBundleOptions {
  apikey: string
  appId: string
  bundle: string
  supaHost?: string
  supaAnon?: string
  reporter: UploadReporter
}

interface FinalizeInvokeOptions {
  apikey: string
  method?: string
  body?: { app_id: string, name: string }
  supaHost?: string
  supaAnon?: string
}

interface FinalizeBundleDependencies {
  invoke: (path: string, options: FinalizeInvokeOptions) => Promise<{ data: unknown, error: Error | null }>
  formatError: (error: unknown) => Promise<string>
}

const defaultDependencies: FinalizeBundleDependencies = {
  invoke: async (path, options) => invokeCapgoCliApi(path, options),
  formatError: formatCapgoCliInvokeError,
}

export async function finalizeUploadedBundle(
  options: FinalizeBundleOptions,
  legacyFinalize: () => Promise<void>,
  dependencies: FinalizeBundleDependencies = defaultDependencies,
): Promise<void> {
  const { data: config, error: configError } = await dependencies.invoke('private/config', {
    apikey: options.apikey,
    method: 'GET',
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
  if (configError || !(config as { useNewFinalizeBundleUpload?: boolean } | null)?.useNewFinalizeBundleUpload) {
    await legacyFinalize()
    return
  }

  const spinner = options.reporter.spinner()
  spinner.start('Finalizing bundle upload...')

  const { error } = await dependencies.invoke('private/finalize_bundle_upload', {
    apikey: options.apikey,
    body: { app_id: options.appId, name: options.bundle },
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  if (error) {
    const message = `Cannot finalize bundle upload: ${await dependencies.formatError(error)}`
    spinner.error(message)
    throw new CliUserError(message)
  }

  spinner.stop('Bundle upload finalized')
}
