import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const redirects = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8')
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')

function firstMatchingRedirectLine(path: string) {
  const lines = redirects
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

  for (const line of lines) {
    const [source] = line.split(/\s+/)
    if (source === path)
      return line
    if (source?.endsWith('/*') && path.startsWith(source.slice(0, -1)))
      return line
  }
  return undefined
}

describe('well-known change-password', () => {
  it.concurrent('redirects password managers to the account change-password page', () => {
    expect(firstMatchingRedirectLine('/.well-known/change-password'))
      .toBe('/.well-known/change-password /settings/account/change-password 302')
  })

  it.concurrent('404s the chrome well-known probe before the deep-link catch-all', () => {
    expect(firstMatchingRedirectLine('/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200'))
      .toBe('/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200 /404 404')
  })

  it.concurrent('keeps apple and android deep-link well-known rewrites', () => {
    expect(firstMatchingRedirectLine('/.well-known/apple-app-site-association'))
      .toBe('/.well-known/* /deepLink/:splat 200')
    expect(firstMatchingRedirectLine('/.well-known/assetlinks.json'))
      .toBe('/.well-known/* /deepLink/:splat 200')
  })

  it.concurrent('does not force json content-type on the change-password well-known path', () => {
    const changePasswordIndex = headers.indexOf('/.well-known/change-password')
    const jsonCatchAllIndex = headers.indexOf('/.well-known/*')
    expect(changePasswordIndex).toBeGreaterThanOrEqual(0)
    expect(changePasswordIndex).toBeLessThan(jsonCatchAllIndex)
    expect(headers).toContain('Content-Type: text/html; charset=utf-8')
  })
})
