import type { PreviewQrCommandOptions } from '../preview/qr'
import type { OptionsUpload } from './upload_interface'

export function buildBundleUploadPreviewQrOptions(options: OptionsUpload, bundle: string): PreviewQrCommandOptions {
  return {
    apikey: options.apikey,
    bundle,
    apiHost: options.apiHost,
  }
}
