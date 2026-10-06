import type { Context } from 'hono'
import { z } from 'zod'
import { quickError } from './hono.ts'
import { getEnv } from './utils.ts'

const dnsHostnameSchema = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
export const hostnameSchema = dnsHostnameSchema.refine(host => !host.endsWith('.capgo.app') && host !== 'capgo.app')

export interface CustomHostname {
  id: string
  hostname: string
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

export async function cloudflareCustomHostname(c: Context, method: 'GET' | 'POST' | 'DELETE', id = '', hostname?: string): Promise<CustomHostname | null> {
  const { token } = customDomainConfig(c)
  const zoneResponse = await fetch('https://api.cloudflare.com/client/v4/zones?name=capgo.app&status=active', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  })
  const zones = await zoneResponse.json().catch(() => ({ success: false })) as { success: boolean, result?: Array<{ id: string, name: string }> }
  const zoneId = zones.result?.find(zone => zone.name === 'capgo.app')?.id
  if (!zoneResponse.ok || !zones.success || !zoneId)
    quickError(502, 'custom_domain_provider_error', 'Unable to access the custom domain zone. Please contact support.')
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames${id ? `/${encodeURIComponent(id)}` : ''}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    ...(method === 'POST' ? { body: JSON.stringify({ hostname, ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } }) } : {}),
  })
  if (method === 'DELETE' && response.status === 404)
    return null
  const data = await response.json().catch(() => ({ success: false })) as { success: boolean, result?: CustomHostname }
  if (!response.ok || !data.success)
    quickError(502, 'custom_domain_provider_error', 'Unable to update the custom domain. Please retry or contact support.')
  if (method !== 'DELETE' && (!data.result?.id || !data.result.hostname))
    quickError(502, 'custom_domain_provider_error', 'The domain provider returned an invalid response.')
  return data.result ?? null
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
