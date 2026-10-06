// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inboxDevice, validateInboxMessage } from '../src/services/inbox'
import { useDialogV2Store } from '../src/stores/dialogv2'

vi.mock('../src/services/supabase', () => ({ useSupabase: vi.fn(), getLocalConfig: () => ({ supaHost: 'https://sb.capgo.app' }) }))
beforeEach(() => setActivePinia(createPinia()))

describe('generic inbox messages', () => {
  it('distinguishes a desktop browser, mobile web, and iPad desktop user agents', () => {
    expect(inboxDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 0).class).toBe('desktop')
    expect(inboxDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 5).class).toBe('mobile')
    expect(inboxDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toMatchObject({ class: 'tablet', os: { name: 'iPadOS' } })
  })

  it('only accepts HTTPS message frames on the configured service origin and clamps excessive preferred dimensions', () => {
    const message = { id: 'example-message', embed_url: `https://sb.capgo.app/__messages/${'v'.repeat(43)}`, presentation: { preferred_width: 9000, preferred_height: 5000 } }
    expect(validateInboxMessage(message)?.presentation).toEqual({ preferred_width: 1200, preferred_height: 900 })
    for (const embed_url of ['javascript:alert(1)', `https://untrusted.example.com/__messages/${'v'.repeat(43)}`, 'https://sb.capgo.app/auth/v1/authorize', `${message.embed_url}?access_token=example`])
      expect(validateInboxMessage({ ...message, embed_url })).toBeNull()
    expect(validateInboxMessage({ ...message, presentation: { preferred_width: -1, preferred_height: 500 } })).toBeNull()
    expect(validateInboxMessage(null)).toBeNull()
  })

  it('reports a deliberate close once and distinguishes navigation/replacement', async () => {
    const store = useDialogV2Store()
    const onClose = vi.fn()
    store.openDialog({ onClose })
    await store.closeDialog(undefined, 'escape')
    await store.closeDialog(undefined, 'escape')
    expect(onClose.mock.calls).toEqual([['escape']])
    store.openDialog({ onClose })
    await store.closeDialog(undefined, 'navigation')
    expect(onClose).toHaveBeenLastCalledWith('navigation')
    store.openDialog({ onClose })
    store.openDialog({})
    expect(onClose).toHaveBeenLastCalledWith('replaced')
  })
})
