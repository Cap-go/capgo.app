import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  APP_ONBOARDING_READY_EVENT,
  buildAppOnboardingReadyBentoEvent,
} from '../supabase/functions/_backend/utils/onboarding_app_ready_tracking.ts'

const creatorId = '7e64f484-4171-47b6-86f7-0ef5d49e0ef8'

function createContext() {
  return {
    env: { WEBAPP_URL: 'https://console.example/' },
  } as unknown as Context
}

function pendingApp() {
  return {
    app_id: 'com.example.pending',
    existing_app: true,
    name: 'Example app',
    need_onboarding: true,
    onboarding: {
      created_by_user_id: creatorId,
      created_by_email: 'creator@example.com',
    },
  }
}

const org = {
  id: 'org-id',
  name: 'Example org',
  onboarding: { intent: 'ota' },
  website: 'https://example.com',
}

describe('pending app onboarding-ready Bento event', () => {
  it.concurrent('includes branching metadata and a permanent per-app duplicate guard', () => {
    expect(buildAppOnboardingReadyBentoEvent(
      createContext(),
      APP_ONBOARDING_READY_EVENT,
      org,
      pendingApp(),
    )).toEqual({
      data: {
        existing_app: true,
        app_id: 'com.example.pending',
        app_name: 'Example app',
        created_by_email: 'creator@example.com',
        created_by_user_id: creatorId,
        onboarding_intent: 'ota',
        onboarding_url: null,
        onboarding_url_builder: null,
        onboarding_url_ota: null,
        org_id: 'org-id',
        org_name: 'Example org',
        org_website: 'https://example.com',
      },
      event: APP_ONBOARDING_READY_EVENT,
      once: true,
      preferenceKey: 'onboarding',
      uniqId: 'app:onboarding_ready:com.example.pending',
    })
  })

  it.concurrent('does not emit for another event or after pending onboarding completes', () => {
    expect(buildAppOnboardingReadyBentoEvent(createContext(), 'app:created', org, pendingApp())).toBeUndefined()
    expect(buildAppOnboardingReadyBentoEvent(
      createContext(),
      APP_ONBOARDING_READY_EVENT,
      org,
      { ...pendingApp(), need_onboarding: false },
    )).toBeUndefined()
  })
})
