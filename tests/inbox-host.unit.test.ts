// @vitest-environment happy-dom
import type { App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import InboxMessages from '../src/components/InboxMessages.vue'
import { useDialogV2Store } from '../src/stores/dialogv2'

const state = vi.hoisted(() => ({ main: null as any, orgs: null as any, route: null as any, lookup: vi.fn(), record: vi.fn() }))
vi.mock('~/stores/main', () => ({ useMainStore: () => state.main }))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => state.orgs }))
vi.mock('vue-router', () => ({ useRoute: () => state.route }))
vi.mock('~/modules/i18n', () => ({ getSelectedLanguage: () => 'fr' }))
vi.mock('~/services/inbox', () => ({
  getInboxMessage: state.lookup,
  recordInboxEvent: state.record,
  inboxContext: (scope: object) => ({ ...scope, device: { class: 'desktop' }, runtime: { platform: 'web', is_native: false }, viewport: { width: 1440, height: 900 } }),
}))

let app: App | undefined
const message = { id: 'example', embed_url: `https://sb.capgo.app/__messages/${'v'.repeat(43)}`, presentation: { preferred_width: 720, preferred_height: 520 } }
beforeEach(() => {
  vi.useFakeTimers()
  state.lookup.mockReset().mockResolvedValue(message)
  state.record.mockReset().mockResolvedValue(undefined)
  state.main = reactive({ auth: { id: 'example-user' } })
  state.orgs = reactive({ currentOrganization: { gid: 'selected-org' }, getOrgByAppId: () => ({ gid: 'app-org' }) })
  state.route = reactive({ path: '/app/com.example.app/channels', params: { app: 'com.example.app' }, matched: [{ path: '/app/:app/channels' }] })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  const pinia = createPinia()
  setActivePinia(pinia)
  const container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(InboxMessages)
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'fr', messages: { fr: { 'inbox-message': 'Message' } } }))
  app.mount(container)
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('background inbox host', () => {
  it('uses the app organization and selected locale, then records one deliberate dismissal', async () => {
    await vi.advanceTimersByTimeAsync(2500)
    expect(state.lookup).toHaveBeenCalledWith(expect.objectContaining({ org_id: 'app-org', app_id: 'com.example.app', locale: 'fr', page: '/app/:app/channels' }), expect.any(AbortSignal))
    const dialog = useDialogV2Store()
    expect(dialog.dialogOptions.embed?.url).toBe(message.embed_url)
    dialog.dialogOptions.onEmbedReady?.()
    await dialog.closeDialog(undefined, 'close_button')
    expect(state.record.mock.calls).toEqual([[message, 'shown', 'ready'], [message, 'dismissed', 'close_button']])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dialog.showDialog).toBe(false)
  })

  it('ignores a late response when the user navigates', async () => {
    let resolve: (value: typeof message) => void = () => {}
    state.lookup.mockImplementationOnce(() => new Promise((done) => {
      resolve = done
    }))
    await vi.advanceTimersByTimeAsync(2500)
    state.route.path = '/settings/account'
    state.route.params = {}
    await nextTick()
    resolve(message)
    await nextTick()
    expect(useDialogV2Store().showDialog).toBe(false)
  })

  it('defers to another dialog and never opens for an unauthenticated user', async () => {
    const dialog = useDialogV2Store()
    dialog.openDialog({ title: 'Existing dialog' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(state.lookup).not.toHaveBeenCalled()
    await dialog.closeDialog()
    state.main.auth = undefined
    await vi.advanceTimersByTimeAsync(2500)
    expect(state.lookup).not.toHaveBeenCalled()
  })
})
