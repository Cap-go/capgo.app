import type { CloudflareRequest } from '../scripts/setup-assistant-waf.ts'
import { describe, expect, it, vi } from 'vitest'
import { ASSISTANT_EXCEPTION, COMMAND_INJECTION_RULE, MANAGED_RULESET, setupAssistantWaf } from '../scripts/setup-assistant-waf.ts'

const zone = '0'.repeat(32)
const deployment = { id: 'deployment', action: 'execute', enabled: true, action_parameters: { id: MANAGED_RULESET } }
const unrelated = { id: 'other', action: 'skip', expression: 'http.host eq "other.example"', action_parameters: { rules: { other: ['other-rule'] } } }
const installed = { id: 'assistant', ...ASSISTANT_EXCEPTION }
const catalog = { id: MANAGED_RULESET, rules: [{ id: COMMAND_INJECTION_RULE, action: 'block' }] }

function api(rules: Awaited<ReturnType<CloudflareRequest>>['rules'], readback = [unrelated, installed, deployment]) {
  return vi.fn<CloudflareRequest>()
    .mockResolvedValueOnce({ id: 'entrypoint', rules })
    .mockResolvedValueOnce(catalog)
    .mockResolvedValueOnce({ id: 'entrypoint', rules: readback })
    .mockResolvedValueOnce({ id: 'entrypoint', rules: readback })
}

describe('assistant WAF exception', () => {
  it.concurrent('only skips the proven rule on the exact JSON POST endpoint', () => {
    expect(ASSISTANT_EXCEPTION.action_parameters).toEqual({ rules: { [MANAGED_RULESET]: [COMMAND_INJECTION_RULE] } })
    expect(ASSISTANT_EXCEPTION.expression).toBe('(http.host eq "api.capgo.app" and http.request.uri.path eq "/private/assistant/responses" and http.request.method eq "POST" and any(http.request.headers["content-type"][*] eq "application/json"))')
    expect(ASSISTANT_EXCEPTION.logging.enabled).toBe(true)
  })

  it.concurrent('previews without writing by default', async () => {
    const request = api([unrelated, deployment])
    expect(await setupAssistantWaf(request, zone)).toMatchObject({ action: 'create', dryRun: true })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(call => call[1] === undefined)).toBe(true)
  })

  it.concurrent('inserts before the managed deployment and reads back without replacing other rules', async () => {
    const request = api([unrelated, deployment])
    await expect(setupAssistantWaf(request, zone, true)).resolves.toEqual({ action: 'create', ruleId: 'assistant', verified: true })
    const [path, init] = request.mock.calls[2]!
    expect(path).toBe(`/zones/${zone}/rulesets/entrypoint/rules`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ ...ASSISTANT_EXCEPTION, position: { before: 'deployment' } })
    expect(request.mock.calls[3]![0]).toBe(request.mock.calls[0]![0])
  })

  it.concurrent('does not duplicate or rewrite a correctly installed exception', async () => {
    const request = api([unrelated, installed, deployment])
    await expect(setupAssistantWaf(request, zone, true)).resolves.toEqual({ action: 'unchanged', ruleId: 'assistant' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.concurrent.each([
    [unrelated, deployment, installed],
    [unrelated, { ...installed, enabled: false }, deployment],
    [unrelated, { ...installed, action_parameters: { ruleset: 'current' } }, deployment],
  ])('repairs a misplaced, disabled or overly broad exception using only its rule ID', async (...rules) => {
    const request = api(rules)
    await expect(setupAssistantWaf(request, zone, true)).resolves.toMatchObject({ action: 'update', verified: true })
    expect(request.mock.calls[2]![0]).toBe(`/zones/${zone}/rulesets/entrypoint/rules/assistant`)
    expect(request.mock.calls[2]![1]?.method).toBe('PATCH')
    expect(JSON.parse(String(request.mock.calls[2]![1]?.body))).toEqual({ ...ASSISTANT_EXCEPTION, position: { before: 'deployment' } })
  })

  it.concurrent.each([[], [{ ...deployment, enabled: false }]])('refuses to add an exception without an active managed deployment', async (...rules) => {
    const request = api(rules)
    await expect(setupAssistantWaf(request, zone, true)).rejects.toThrow('not deployed')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.concurrent('stops on missing catalog rules or read permission errors', async () => {
    const request = api([deployment])
    request.mockReset().mockResolvedValueOnce({ id: 'entrypoint', rules: [deployment] }).mockResolvedValueOnce({ id: MANAGED_RULESET, rules: [] })
    await expect(setupAssistantWaf(request, zone, true)).rejects.toThrow('absent')
    expect(request).toHaveBeenCalledTimes(2)
    const denied = vi.fn<CloudflareRequest>().mockRejectedValue(new Error('HTTP 403'))
    await expect(setupAssistantWaf(denied, zone, true)).rejects.toThrow('403')
    expect(denied).toHaveBeenCalledTimes(1)
  })

  it.concurrent('rejects duplicate exceptions and failed readback', async () => {
    const duplicate = api([installed, installed, deployment])
    await expect(setupAssistantWaf(duplicate, zone, true)).rejects.toThrow('Duplicate')
    expect(duplicate).toHaveBeenCalledTimes(2)
    await expect(setupAssistantWaf(api([deployment], [unrelated, deployment, installed]), zone, true)).rejects.toThrow('readback failed')
  })
})
