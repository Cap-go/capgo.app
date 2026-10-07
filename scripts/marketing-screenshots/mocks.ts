import type { Page, Route } from '@playwright/test'
import * as fx from './fixtures'

// Route mocks for everything the local stack cannot serve with realistic data:
// analytics-backed edge endpoints (stats, notifications, devices, keys,
// webhooks) and the team/audit RPCs whose seed rows would expose test users.

const ORG_ID = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const PASSWORD_POLICY = { enabled: true, min_length: 12, require_uppercase: true, require_number: true, require_special: true }

function json(route: Route, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function restPath(name: string) {
  return (url: URL) => url.pathname.endsWith(`/rest/v1/${name}`)
}

function edgeResponse(path: string, url: URL, body: any): unknown {
  const days = Number(body.days ?? 7)
  if (path === '/private/sso/check-enforcement')
    return { allowed: true }
  if (path === '/private/sso/check-domain')
    return { has_sso: false }
  if (path === '/private/plans')
    return []
  if (path.startsWith('/statistics/org/'))
    return { global: [], byApp: [] }
  if (path === '/private/events')
    return { status: 'ok' }
  if (path === '/private/native_observe_stats')
    return body.view === 'plugins' ? fx.pluginAdoption() : fx.nativeObserve(days, body.version_group ?? 'version')
  if (path === '/private/stats/insights')
    return fx.insights(days, body.versionName)
  if (path === '/private/stats')
    return body.devicesId?.length ? fx.deployments(body.devicesId[0]) : fx.logs(body.rangeEnd)
  if (path === '/private/devices')
    return fx.devices(body)
  if (path === '/private/release_live')
    return fx.releaseLive()
  if (path === '/private/bundle_install_stats')
    return fx.bundleInstallStats(days)
  if (path === '/private/update_delivery_stats')
    return fx.deliveryStats(days)
  if (path === '/notifications/providers')
    return fx.notifProviders()
  if (path === '/notifications/campaigns')
    return fx.notifCampaigns()
  if (path === '/notifications/stats')
    return fx.notifStats(url.searchParams.get('campaign_id'))
  if (path === '/notifications/settings')
    return fx.notifSettings
  if (path === '/apikey')
    return fx.apiKeys()
  if (path === '/webhooks')
    return fx.webhooks()
  if (path === '/webhooks/deliveries')
    return fx.webhookDeliveries(url.searchParams.get('webhookId') ?? 'wh-1')
  if (path.startsWith('/private/sso/providers'))
    return fx.ssoProviders()
  if (path === '/private/sso/sp-metadata')
    return fx.ssoMetadata
  if (path.startsWith('/private/role_bindings/'))
    return []
  const usage = path.match(/\/statistics\/app\/[^/]+\/(bundle_usage|native_usage)/)
  if (usage)
    return fx.usage(usage[1] as 'bundle_usage' | 'native_usage', url.searchParams.get('from')!, url.searchParams.get('to')!)
  return undefined
}

export async function installMocks(page: Page) {
  await page.route('**/functions/v1/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' },
      })
    }
    const url = new URL(request.url())
    const path = url.pathname.replace(/^.*\/functions\/v1/, '')
    let body: any = {}
    try {
      body = request.postDataJSON() ?? {}
    }
    catch {}
    const response = edgeResponse(path, url, body)
    if (response === undefined)
      console.warn(`[marketing-screenshots] unmocked ${request.method()} ${path}`)
    return json(route, response ?? {})
  })

  await page.route(restPath('compatibility_events'), (route) => {
    const rows = fx.compatibilityEvents().filter(row => !route.request().url().includes('resolved_at=is.null') || !row.resolved_at)
    return json(route, route.request().method() === 'HEAD' ? '' : rows, { 'Content-Range': `0-${rows.length - 1}/${rows.length}` })
  })
  await page.route(restPath('audit_logs'), (route) => {
    const rows = fx.auditLogs()
    return json(route, route.request().method() === 'HEAD' ? '' : rows, { 'Content-Range': `0-${rows.length - 1}/${rows.length}` })
  })
  await page.route(restPath('rpc/get_org_members_rbac'), route => json(route, fx.orgMembersRbac()))
  await page.route(restPath('rpc/get_org_members'), route => json(route, fx.orgMembers()))
  await page.route(restPath('rpc/check_org_members_2fa_enabled'), route => json(route, fx.members2fa()))
  await page.route(restPath('rpc/check_org_members_password_policy'), route => json(route, fx.people.map(p => ({ user_id: p.uid, password_policy_compliant: true, first_name: '', last_name: '' }))))
  await page.route(restPath('rpc/get_app_access_rbac'), route => json(route, fx.appAccess()))
  // The live panel falls back to this query for rollout state; the mocked release payload already carries it.
  await page.route(url => restPath('channels')(url) && url.searchParams.get('select')?.startsWith('rollout_enabled') === true, route => json(route, []))
  // Hide the "deploy the latest bundle" banner: the demo intentionally keeps production behind beta.
  await page.route(url => restPath('channels')(url) && url.searchParams.get('select')?.startsWith('id,name,ios') === true, route => json(route, []))
  await page.route('https://registry.npmjs.org/**', route => json(route, { 'dist-tags': { 'latest': '8.42.3', 'lts-v7': '7.51.23', 'lts-v6': '6.51.23', 'lts-v5': '5.51.23' } }))

  // Present a hardened org (2FA, password policy) without gating the seed login.
  const patchJson = (match: (url: URL) => boolean, patch: (body: any) => any) => page.route(match, async (route) => {
    const res = await route.fetch()
    let body: any
    try {
      body = await res.json()
    }
    catch {
      return route.fulfill({ response: res })
    }
    return route.fulfill({ response: res, body: JSON.stringify(patch(body)) })
  })
  const hardenOrg = (org: any) => ({ ...org, enforcing_2fa: true, enforce_hashed_api_keys: true, password_policy_config: PASSWORD_POLICY })
  await patchJson(restPath('rpc/get_orgs_v7'), body => Array.isArray(body)
    ? body.map((org: any) => org.gid === ORG_ID ? { ...hardenOrg(org), '2fa_has_access': true, 'password_has_access': true } : org)
    : body)
  await patchJson(restPath('orgs'), body => Array.isArray(body) ? body.map(hardenOrg) : hardenOrg(body))
}

const IDENTITY_MAP: Record<string, string> = {
  'test@capgo.app': 'demo@capgo.app',
  'test2@capgo.app': 'maya@example.com',
  'admin@capgo.app': 'jordan@example.com',
  'test Capgo': 'Demo User',
}

/** Replace seed-account identities left in the rendered page with neutral demo ones. */
export async function maskIdentities(page: Page) {
  await page.evaluate((map) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [from, to] of Object.entries(map)) {
        if (node.nodeValue?.includes(from))
          node.nodeValue = node.nodeValue.replaceAll(from, to)
      }
    }
  }, IDENTITY_MAP)
}
