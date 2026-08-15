import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pagePath = new URL('../src/pages/login-cli.vue', import.meta.url)
const auth = readFileSync(new URL('../src/modules/auth.ts', import.meta.url), 'utf8')
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

describe('/login-cli page contract', () => {
  it.concurrent('uses the naked layout and does not reuse connect controls', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('layout: naked')
    expect(page).not.toContain('ConnectAppPicker')
    expect(page).not.toContain('tokenName')
    expect(page).not.toContain('selectedOrgIds')
  })

  it.concurrent('keeps a fake key in the DOM until explicit reveal', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain("const hiddenKey = 'capgo_xxxxxxxxxxxxxxxxxxxx'")
    expect(page).toContain('revealed.value && secret.value ? secret.value : hiddenKey')
    expect(page).toContain('await navigator.clipboard.writeText(secret.value)')
    expect(page).toContain('secret.value = null')
  })

  it.concurrent('does not prepare a key without a valid session', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('if (!isValidCliLoginSession(route.query.session))')
    expect(page.indexOf('if (!isValidCliLoginSession(route.query.session))'))
      .toBeLessThan(page.indexOf('prepareCliLoginKey('))
  })

  it.concurrent('keeps the route out of normal onboarding redirects', () => {
    expect(auth).toContain("const isCliLoginRoute = to.path === '/login-cli'")
    expect(auth.match(/if \(isCliLoginRoute\)/g)).toHaveLength(3)
  })

  it.concurrent('contains focused key, paste, warning, waiting, and success copy', () => {
    expect(messages['cli-login-direct-description']).toContain("{'@'}capgo/cli{'@'}latest")
    expect(messages['cli-login-paste-instruction']).toContain('terminal')
    expect(messages['cli-login-security-warning']).toContain('trust')
    expect(messages['cli-login-copy-note']).toContain('hidden')
    expect(messages['cli-login-waiting']).toContain('Waiting')
    expect(messages['cli-login-success-title']).toContain('successful')
  })

  it.concurrent('uses prefixed DaisyUI primitives and resolves the destination before success', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('class="d-btn')
    expect(page).toContain('class="d-alert')
    expect(page).not.toMatch(/class="(?:btn|alert)(?:\s|\")/)
    expect(page.indexOf('destination.value = await resolveDestination()'))
      .toBeLessThan(page.indexOf("state.value = 'success'"))
  })
})
