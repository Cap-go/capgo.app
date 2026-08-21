import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pagePath = new URL('../src/pages/login-cli.vue', import.meta.url)
const auth = readFileSync(new URL('../src/modules/auth.ts', import.meta.url), 'utf8')
const organizationStore = readFileSync(new URL('../src/stores/organization.ts', import.meta.url), 'utf8')
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
    expect(page).toContain(`const hiddenKey = 'capgo_xxxxxxxxxxxxxxxxxxxx'`)
    expect(page).toContain('revealed.value && secret.value ? secret.value : hiddenKey')
    expect(page).toContain('revealDialogOpen.value = true')
    expect(page).toContain('revealed.value = true')
    expect(page).toContain('await navigator.clipboard.writeText(secret.value)')
    expect(page).toContain('await copyKey()')
    expect(page).toContain('secret.value = null')
  })

  it.concurrent('shows preparation progress and a three-action reveal dialog', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('d-loading d-loading-spinner')
    expect(page).toContain('IconEyeSlash v-if="revealed"')
    expect(page).toContain('IconEye v-else')
    expect(page).toContain('@click="closeRevealDialog"')
    expect(page).toContain('@click="copyFromRevealDialog"')
    expect(page).toContain('@click="confirmReveal"')
    expect(page).toContain('aria-labelledby="cli-login-reveal-dialog-title"')
  })

  it.concurrent('traps reveal-dialog focus and restores it to the reveal button', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('ref="revealButtonRef"')
    expect(page).toContain('ref="revealDialogRef"')
    expect(page).toContain(`window.addEventListener('keydown', onRevealDialogKeydown)`)
    expect(page).toContain(`if (event.key !== 'Tab')`)
    expect(page).toContain('revealButtonRef.value?.focus()')
  })

  it.concurrent('animates the waiting state and keeps reused-key info as a final footnote', () => {
    const page = readFileSync(pagePath, 'utf8')
    const waitingStatus = page.indexOf('d-loading d-loading-dots')
    const reusedFootnote = page.indexOf(`t('cli-login-reused')`)
    const readyStateEnd = page.indexOf(`      </div>\n\n      <div v-else-if="state === 'success'"`)

    expect(waitingStatus).toBeGreaterThanOrEqual(0)
    expect(reusedFootnote).toBeGreaterThan(waitingStatus)
    expect(reusedFootnote).toBeLessThan(readyStateEnd)
    expect(page).toContain('text-xs text-slate-400')
    expect(page).toContain('<span aria-hidden="true">*</span>')
  })

  it.concurrent('keeps the full revealed key visible without truncation', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('whitespace-normal break-all')
    expect(page).not.toContain('flex-1 truncate')
  })

  it.concurrent('does not prepare a key without a valid session', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('const session = route.query.session')
    expect(page).toContain('if (!aiMode.value && !isValidCliLoginSession(session))')
    expect(page.indexOf('if (!aiMode.value && !isValidCliLoginSession(session))'))
      .toBeLessThan(page.indexOf('prepareCliLoginKey('))
  })

  it.concurrent('supports a direct AI setup prompt containing the prepared key', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain(`const aiMode = computed(() => route.query.ai === '1')`)
    expect(page).toContain('`npx @capgo/cli@latest init $' + '{secret.value}`')
    expect(page).toContain(`t('cli-login-ai-prompt'`)
    expect(page).toContain(`apiKeyGuidance: t('app-onboarding-ai-help-with-key')`)
    expect(page).toContain('await navigator.clipboard.writeText(aiPrompt.value)')
    expect(page).toContain(`v-if="aiMode"`)
    expect(page).toContain(`t('cli-login-ai-copy')`)
  })

  it.concurrent('keeps the route out of normal onboarding redirects', () => {
    expect(auth).toContain(`const isCliLoginRoute = to.path === '/login-cli'`)
    expect(auth.match(/if \(isCliLoginRoute\)/g)).toHaveLength(3)
  })

  it.concurrent('defers organization image signing on the CLI login route', () => {
    expect(auth).toContain('const organizationFetchOptions = { loadImages: !isCliLoginRoute }')
    expect(auth).toContain('organizationStore.fetchOrganizations(organizationFetchOptions)')
    expect(auth).toContain('organizationStore.dedupFetchOrganizations(organizationFetchOptions)')
    expect(organizationStore).not.toContain('let loadOrganizationImages')
    expect(organizationStore).toContain('const loadImages = options.loadImages ?? true')
    expect(organizationStore).toContain('loadOrganizationApps(selectableOrganizations, loadImages)')
    expect(organizationStore).toContain('loadPendingOrganizationImages()')
    expect(organizationStore).toContain('if (pendingOrganizationImageLoad)')
    expect(organizationStore).toContain('pendingOrganizationImageLoadRequested = true')
    expect(organizationStore).toContain('if (pendingOrganizationImageLoadRequested)')
  })

  it.concurrent('contains focused key, paste, warning, waiting, and success copy', () => {
    expect(messages['cli-login-direct-description']).toContain(`{'@'}capgo/cli{'@'}latest`)
    expect(messages['cli-login-paste-instruction']).toContain('terminal')
    expect(messages['cli-login-security-warning']).toContain('trust')
    expect(messages['cli-login-copy-note']).toContain('hidden')
    expect(messages['cli-login-waiting']).toContain('Waiting')
    expect(messages['cli-login-success-title']).toContain('successful')
    expect(messages['cli-login-ai-description']).toContain('AI assistant')
    expect(messages['cli-login-ai-security-warning']).toContain('API key')
    expect(messages['cli-login-ai-prompt']).toContain('{command}')
    expect(messages['cli-login-ai-prompt']).toContain('{apiKeyGuidance}')
  })

  it.concurrent('uses prefixed DaisyUI primitives and resolves the destination before success', () => {
    const page = readFileSync(pagePath, 'utf8')
    const resolveDestination = page.indexOf('destination.value = await resolveDestination()')
    const assignSuccess = page.indexOf(`state.value = 'success'`)

    expect(page).toContain('class="d-btn')
    expect(page).toContain('class="d-alert')
    expect(page).not.toMatch(/class="(?:btn|alert)(?:\s|")/)
    expect(resolveDestination).toBeGreaterThanOrEqual(0)
    expect(assignSuccess).toBeGreaterThanOrEqual(0)
    expect(resolveDestination).toBeLessThan(assignSuccess)
  })
})
