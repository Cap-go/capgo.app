import { buildChannelPreviewSubdomain, buildPreviewSubdomain } from '../shared/preview-subdomain'
import type { PreviewQrTarget } from './qr'

export type PreviewWebEnv = 'prod' | 'preprod' | 'dev'

export function buildPreviewWebUrl(target: PreviewQrTarget, env: PreviewWebEnv = 'prod'): string {
  const envPrefix = env === 'prod' ? '' : `.${env}`
  const subdomain = target.kind === 'channel'
    ? buildChannelPreviewSubdomain(target.appId, target.channelId)
    : buildPreviewSubdomain(target.appId, target.versionId)

  return `https://${subdomain}.preview${envPrefix}.capgo.app/`
}
