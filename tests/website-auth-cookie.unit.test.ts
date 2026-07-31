import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWebsitePaidUserCookie, syncWebsitePaidUserCookieFromOrganizations } from '../src/services/websiteAuthCookie.ts'

const localConfig = vi.hoisted(() => ({
  value: {
    host: 'https://console.capgo.app',
    hostWeb: 'https://www.capgo.app' as string | undefined,
  },
}))

vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => localConfig.value,
}))

describe('website paid user cookie', () => {
  let cookieWrites: string[]

  beforeEach(() => {
    localConfig.value = {
      host: 'https://console.capgo.app',
      hostWeb: 'https://www.capgo.app',
    }
    cookieWrites = []
    vi.stubGlobal('document', {
      get cookie() {
        return ''
      },
      set cookie(value: string) {
        cookieWrites.push(value)
      },
    })
    vi.stubGlobal('location', {
      hostname: 'console.capgo.app',
      protocol: 'https:',
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sets a 30 day cookie for paid non-invite organizations', () => {
    syncWebsitePaidUserCookieFromOrganizations([
      { paying: false, role: 'owner' },
      { paying: true, role: 'read' },
    ])

    expect(cookieWrites).toContain('capgo_paid_user=1; Path=/; Max-Age=2592000; SameSite=Lax; Domain=.capgo.app; Secure')
  })

  it('falls back to the console host when the landing URL is not configured', () => {
    localConfig.value = {
      host: 'https://console.capgo.app',
      hostWeb: undefined,
    }

    syncWebsitePaidUserCookieFromOrganizations([
      { paying: true, role: 'owner' },
    ])

    expect(cookieWrites).toContain('capgo_paid_user=1; Path=/; Max-Age=2592000; SameSite=Lax; Domain=.capgo.app; Secure')
  })

  it('clears the cookie when paid access is only from an invite', () => {
    syncWebsitePaidUserCookieFromOrganizations([
      { is_invite: true, paying: true, role: 'org_member' },
    ])

    expect(cookieWrites).toContain('capgo_paid_user=; Path=/; Max-Age=0; SameSite=Lax; Domain=.capgo.app; Secure')
    expect(cookieWrites).toContain('capgo_paid_user=; Path=/; Max-Age=0; SameSite=Lax; Secure')
  })

  it('clears the paid user cookie', () => {
    clearWebsitePaidUserCookie()

    expect(cookieWrites).toContain('capgo_paid_user=; Path=/; Max-Age=0; SameSite=Lax; Domain=.capgo.app; Secure')
    expect(cookieWrites).toContain('capgo_paid_user=; Path=/; Max-Age=0; SameSite=Lax; Secure')
  })
})
