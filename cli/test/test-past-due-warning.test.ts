import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { log } from '@clack/prompts'
import { warnIfPaymentFailed } from '../src/utils.ts'

const realFetch = globalThis.fetch

function stubFetch(pastDue: unknown) {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url.includes('/private/stripe_past_due')) {
      if (pastDue instanceof Error)
        throw pastDue
      return new Response(JSON.stringify(pastDue), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('warnIfPaymentFailed', () => {
  it('warns once per org with the hosted invoice link', async () => {
    stubFetch({ past_due: true, invoice: { hosted_invoice_url: 'https://invoice.stripe.com/i/test' } })
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    await warnIfPaymentFailed('key', 'org-warn')
    await warnIfPaymentFailed('key', 'org-warn')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('https://invoice.stripe.com/i/test')
    warn.mockRestore()
  })

  it('stays quiet when the org is not past due', async () => {
    stubFetch({ past_due: false, invoice: null })
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    await warnIfPaymentFailed('key', 'org-ok')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never throws when the billing check fails', async () => {
    stubFetch(new Error('network down'))
    await expect(warnIfPaymentFailed('key', 'org-error')).resolves.toBeUndefined()
  })

  it('skips the request in silent mode', async () => {
    const calls = stubFetch({ past_due: true, invoice: null })
    await warnIfPaymentFailed('key', 'org-silent', { silent: true })
    expect(calls.some(url => url.includes('stripe_past_due'))).toBe(false)
  })
})
