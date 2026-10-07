import type { Context } from 'hono'
import { z } from 'zod'
import { quickError } from './hono.ts'
import { cloudlogErr } from './logging.ts'
import { getEnv } from './utils.ts'

const dnsHostnameSchema = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
export const hostnameSchema = dnsHostnameSchema.refine(host => !host.endsWith('.capgo.app') && host !== 'capgo.app')

export interface CustomHostname {
  id: string
  hostname: string
  worker_route_id?: string
  status: string
  ownership_verification?: { type: string, name: string, value: string }
  ssl?: {
    status: string
    validation_records?: Array<{ txt_name?: string, txt_value?: string }>
    validation_errors?: Array<{ message: string }>
  }
  verification_errors?: string[]
}

export function customDomainConfig(c: Context) {
  const token = getEnv(c, 'CF_ANALYTICS_TOKEN')
  if (!token)
    quickError(503, 'custom_domains_unavailable', 'Custom domains are not configured. Contact support.')
  return { token, target: 'plugin.capgo.app' }
}

export async function cloudflareCustomHostname(c: Context, method: 'GET' | 'POST' | 'DELETE', id = '', hostname?: string, routeId?: string): Promise<CustomHostname | null> {
  const { token } = customDomainConfig(c)
  // Three provider requests, plus rollback cleanup, stay below the 15s idle transaction limit.
  async function request<T>(path: string, verb = 'GET', body?: unknown): Promise<T | null> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      method: verb,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => quickError(502, 'custom_domain_provider_error', 'Unable to update the custom domain. Please retry or contact support.'))
    if (verb === 'DELETE' && response.status === 404)
      return null
    const data = await response.json().catch(() => ({ success: false })) as { success: boolean, result?: T }
    if (!response.ok || !data.success)
      quickError(502, 'custom_domain_provider_error', 'Unable to update the custom domain. Please retry or contact support.')
    return data.result ?? null
  }
  const zones = await request<Array<{ id: string, name: string }>>('zones?name=capgo.app&status=active')
  const zoneId = Array.isArray(zones) ? zones.find(zone => zone.name === 'capgo.app')?.id : undefined
  if (!zoneId)
    quickError(502, 'custom_domain_provider_error', 'Unable to access the custom domain zone. Please contact support.')
  const base = `zones/${zoneId}`
  if (method === 'DELETE' && routeId)
    await request(`${base}/workers/routes/${encodeURIComponent(routeId)}`, 'DELETE')
  const host = await request<CustomHostname>(`${base}/custom_hostnames${id ? `/${encodeURIComponent(id)}` : ''}`, method, method === 'POST' ? { hostname, ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } } : undefined)
  if (method !== 'DELETE' && (!host?.id || !host.hostname))
    quickError(502, 'custom_domain_provider_error', 'The domain provider returned an invalid response.')
  if (method === 'POST') {
    try {
      const route = await request<{ id: string }>(`${base}/workers/routes`, 'POST', { pattern: `${host!.hostname}/*`, script: 'capgo_plugin-eu-prod' })
      if (!route?.id)
        quickError(502, 'custom_domain_provider_error', 'The domain provider returned an invalid route response.')
      host!.worker_route_id = route.id
    }
    catch (error) {
      await request(`${base}/custom_hostnames/${encodeURIComponent(host!.id)}`, 'DELETE')
        .catch(cleanupError => cloudlogErr({ requestId: c.get('requestId'), message: 'Custom hostname route rollback cleanup failed', error: cleanupError }))
      throw error
    }
  }
  return host
}

export function customDomainInstructions(host: CustomHostname, target: string) {
  const records = [{ type: 'CNAME', name: host.hostname, value: target }]
  if (host.ownership_verification)
    records.push(host.ownership_verification)
  for (const record of host.ssl?.validation_records ?? []) {
    if (record.txt_name && record.txt_value)
      records.push({ type: 'TXT', name: record.txt_name, value: record.txt_value })
  }
  const active = host.status === 'active' && host.ssl?.status === 'active'
  return {
    hostname: host.hostname,
    status: active ? 'active' : 'pending',
    hostname_status: host.status,
    certificate_status: host.ssl?.status ?? 'pending',
    dns_records: records,
    errors: [...host.verification_errors ?? [], ...host.ssl?.validation_errors?.map(error => error.message) ?? []],
    endpoints: active
      ? {
          updateUrl: `https://${host.hostname}/updates`,
          statsUrl: `https://${host.hostname}/stats`,
          channelUrl: `https://${host.hostname}/channel_self`,
        }
      : null,
  }
}
