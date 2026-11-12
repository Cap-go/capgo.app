import { version } from '../utils/version.ts'

export const LATEST_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'] as const

// Shared by initialize and public discovery so identity and protocol versions cannot drift.
export const MCP_SERVER_INFO = {
  name: 'app.capgo/capgo',
  title: 'Capgo',
  version,
  description: 'Build Capacitor apps, upload and deploy live update bundles, and manage releases with Capgo.',
  icons: [{ src: 'https://capgo.app/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  websiteUrl: 'https://capgo.app',
}
