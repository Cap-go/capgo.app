// src/build/prescan/checks/ios-capacitor-config.ts
//
// §2.D — Capacitor config checks. These read only ctx.config (a passthrough
// zod object, so server.* is reached via safe optional access — no parser
// needed). Upload intent escalates severity for the server.url check. All
// findings name only config values, never credential material.
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { willUploadToAppStore } from '../upload-intent'

// ctx.config is `.passthrough()`, so the server block is not in the static type.
// Read it through a narrow shape rather than re-parsing the config.
interface CapServer {
  url?: unknown
  cleartext?: unknown
  allowNavigation?: unknown
}
function serverOf(ctx: ScanContext): CapServer | undefined {
  return (ctx.config as { server?: CapServer } | undefined)?.server
}
function serverUrlOf(ctx: ScanContext): string | null {
  const url = serverOf(ctx)?.url
  return typeof url === 'string' && url !== '' ? url : null
}

// Dev-only markers that make a shipped server.url unambiguously a live-reload
// leftover rather than a deliberate production host.
const RFC1918_RE = /^https?:\/\/(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/i
const LOCALHOST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?:[:/]|$)/i
const TUNNEL_RE = /^https?:\/\/[^/]*\.(?:ngrok\.io|ngrok-free\.app|trycloudflare\.com|loca\.lt)(?:[:/]|$)/i

/** A human-readable reason this url looks like a dev/live-reload target, or null. */
function devTargetReason(url: string): string | null {
  if (LOCALHOST_RE.test(url))
    return 'points at localhost / 127.0.0.1'
  if (RFC1918_RE.test(url))
    return 'points at a private LAN IP (live-reload)'
  if (TUNNEL_RE.test(url))
    return 'points at a dev tunnel host (ngrok / cloudflare / localtunnel)'
  if (/^http:\/\//i.test(url))
    return 'uses cleartext http://'
  return null
}

export const serverUrlShipped: PrescanCheck = {
  id: 'ios/capacitor-server-url-shipped',
  platforms: ['ios'],
  appliesTo: ctx => serverUrlOf(ctx) !== null,
  async run(ctx): Promise<Finding[]> {
    const url = serverUrlOf(ctx)
    if (url === null)
      return []
    const uploading = willUploadToAppStore(ctx)
    const reason = devTargetReason(url)
    const detail = reason
      ? `server.url ${reason} — this ships a live-reload/remote endpoint into the build`
      : 'server.url ships a remote endpoint into the build instead of the bundled web assets'
    return [{
      id: 'ios/capacitor-server-url-shipped',
      severity: uploading ? 'error' : 'warning',
      title: 'capacitor.config server.url is set — the build will load a remote URL instead of bundled assets',
      detail,
      fix: 'Remove the server.url live-reload block before a production build; build web assets and run `npx cap sync`',
    }]
  },
}

export const serverCleartext: PrescanCheck = {
  id: 'ios/capacitor-server-cleartext',
  platforms: ['ios'],
  appliesTo: ctx => serverOf(ctx)?.cleartext === true,
  async run(ctx): Promise<Finding[]> {
    if (serverOf(ctx)?.cleartext !== true)
      return []
    const url = serverUrlOf(ctx)
    const httpUrl = url !== null && /^http:\/\//i.test(url)
    return [{
      id: 'ios/capacitor-server-cleartext',
      severity: httpUrl ? 'error' : 'warning',
      title: 'capacitor.config server.cleartext is enabled — arbitrary cleartext HTTP traffic is allowed',
      detail: httpUrl ? 'paired with a cleartext http:// server.url' : undefined,
      fix: 'Remove server.cleartext (or set it false) for production; use https or a scoped ATS exception',
    }]
  },
}

/** A blanket `*` or public-suffix wildcard (`*.com`, `*.io`) with no specific host. */
function isPublicWildcard(entry: string): boolean {
  if (entry === '*')
    return true
  // `*.<single-label>` such as *.com / *.io — a wildcard with no concrete host.
  // `*.example.com` (two+ labels after the dot) is a specific subdomain wildcard
  // and is NOT flagged.
  return /^\*\.[a-z0-9-]+$/i.test(entry)
}
function navWildcards(ctx: ScanContext): string[] {
  const list = serverOf(ctx)?.allowNavigation
  if (!Array.isArray(list))
    return []
  return list.filter((e): e is string => typeof e === 'string' && isPublicWildcard(e))
}

export const allowNavigationWildcard: PrescanCheck = {
  id: 'ios/capacitor-allow-navigation-wildcard',
  platforms: ['ios'],
  appliesTo: ctx => navWildcards(ctx).length > 0,
  async run(ctx): Promise<Finding[]> {
    const offenders = navWildcards(ctx)
    if (offenders.length === 0)
      return []
    return [{
      id: 'ios/capacitor-allow-navigation-wildcard',
      severity: 'warning',
      title: 'capacitor.config server.allowNavigation contains a blanket wildcard',
      detail: `wildcard entr(y/ies): ${offenders.join(', ')}`,
      fix: 'Restrict allowNavigation to specific hosts; remove blanket "*" / "*.<tld>" entries',
    }]
  },
}
