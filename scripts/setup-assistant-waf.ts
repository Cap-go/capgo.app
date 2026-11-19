#!/usr/bin/env bun
import { isDeepStrictEqual } from 'node:util'

// Public Cloudflare identifiers, not deployment or customer identifiers.
export const MANAGED_RULESET = 'efb7b8c949ac4650a09736fc376e9aee'
export const COMMAND_INJECTION_RULE = '64fa151963064ea09fc8a7df851d2f71'
export const ASSISTANT_RULE_REF = 'capgo_assistant_command_examples'

export const ASSISTANT_EXCEPTION = {
  ref: ASSISTANT_RULE_REF,
  description: 'Allow command examples in authenticated assistant prompts',
  action: 'skip',
  action_parameters: { rules: { [MANAGED_RULESET]: [COMMAND_INJECTION_RULE] } },
  expression: '(http.host eq "api.capgo.app" and http.request.uri.path eq "/private/assistant/responses" and http.request.method eq "POST" and any(http.request.headers["content-type"][*] eq "application/json"))',
  enabled: true,
  logging: { enabled: true },
}

interface Rule {
  id: string
  ref?: string
  action: string
  enabled?: boolean
  action_parameters?: { id?: string } & Record<string, unknown>
  [key: string]: unknown
}
interface Ruleset { id: string, rules: Rule[] }
export type CloudflareRequest = (path: string, init?: RequestInit) => Promise<Ruleset>

function matches(rule: Rule) {
  return Object.entries(ASSISTANT_EXCEPTION).every(([key, value]) => isDeepStrictEqual(rule[key], value))
}

/** Change only our rule, never replace the entrypoint or its other exceptions/overrides. */
export async function setupAssistantWaf(request: CloudflareRequest, zoneId: string, apply = false) {
  if (!/^[a-f0-9]{32}$/.test(zoneId))
    throw new Error('CLOUDFLARE_ZONE_ID must be a zone ID')
  const base = `/zones/${zoneId}/rulesets`
  const entrypointPath = `${base}/phases/http_request_firewall_managed/entrypoint`
  const entrypoint = await request(entrypointPath)
  const deployments = entrypoint.rules.filter(rule => rule.action === 'execute' && rule.enabled !== false && rule.action_parameters?.id === MANAGED_RULESET)
  if (!deployments.length)
    throw new Error('Cloudflare Managed Ruleset is not deployed; refusing to create an ineffective exception')
  const managed = await request(`${base}/${MANAGED_RULESET}`)
  if (!managed.rules.some(rule => rule.id === COMMAND_INJECTION_RULE))
    throw new Error('Command-injection rule is absent from the managed catalog; recheck the blocking security event')
  const existing = entrypoint.rules.filter(rule => rule.ref === ASSISTANT_RULE_REF)
  if (existing.length > 1)
    throw new Error('Duplicate assistant exceptions; reconcile them before continuing')
  const current = existing[0]
  const firstDeployment = deployments[0]!
  if (current && matches(current) && entrypoint.rules.indexOf(current) < entrypoint.rules.indexOf(firstDeployment))
    return { action: 'unchanged', ruleId: current.id }

  const body = { ...ASSISTANT_EXCEPTION, position: { before: firstDeployment.id } }
  const action = current ? 'update' : 'create'
  if (!apply)
    return { action, dryRun: true, body }

  await request(`${base}/${entrypoint.id}/rules${current ? `/${current.id}` : ''}`, {
    method: current ? 'PATCH' : 'POST',
    body: JSON.stringify(body),
  })
  const verified = await request(entrypointPath)
  const index = verified.rules.findIndex(rule => rule.ref === ASSISTANT_RULE_REF)
  const deploymentIndex = verified.rules.findIndex(rule => rule.action === 'execute' && rule.enabled !== false && rule.action_parameters?.id === MANAGED_RULESET)
  if (index < 0 || deploymentIndex < 0 || index >= deploymentIndex || !matches(verified.rules[index]!))
    throw new Error('Assistant exception readback failed; inspect the managed entrypoint before retrying')
  return { action, ruleId: verified.rules[index]!.id, verified: true }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--dry-run', '--apply'].includes(arg)) || (args.includes('--dry-run') && args.includes('--apply')))
    throw new Error('Usage: bun scripts/setup-assistant-waf.ts [--dry-run | --apply]')
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token)
    throw new Error('Set CLOUDFLARE_API_TOKEN with Zone WAF Read (preview) or Edit (apply) permission')
  const request: CloudflareRequest = async (path, init) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json() as { success: boolean, result: Ruleset, errors?: Array<{ code: number }> }
    if (!response.ok || !body.success)
      throw new Error(`Cloudflare ${init?.method ?? 'GET'} failed: HTTP ${response.status}, codes ${body.errors?.map(error => error.code).join(',') ?? 'unknown'}`)
    return body.result
  }
  console.log(JSON.stringify(await setupAssistantWaf(request, process.env.CLOUDFLARE_ZONE_ID ?? '', args.includes('--apply')), null, 2))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Assistant WAF setup failed')
    process.exitCode = 1
  })
}
