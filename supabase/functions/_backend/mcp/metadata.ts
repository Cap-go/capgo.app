import { version } from '../utils/version.ts'

export const LATEST_PROTOCOL_VERSION = '2026-07-28'
// initialize belongs to the legacy protocol era; never negotiate a modern version through it.
export const LATEST_LEGACY_PROTOCOL_VERSION = '2025-11-25'
export const LEGACY_PROTOCOL_VERSIONS = [LATEST_LEGACY_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'] as const
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS] as const

// Shared by initialize and public discovery so identity and protocol versions cannot drift.
export const MCP_SERVER_INFO = {
  name: 'app.capgo/capgo',
  title: 'Capgo',
  version,
  description: 'Build Capacitor apps, upload and deploy live update bundles, and manage releases with Capgo.',
  icons: [{ src: 'https://capgo.app/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
  websiteUrl: 'https://capgo.app',
}
