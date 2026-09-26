import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'
import type { BentoTrackingPayload } from './tracking.ts'
import { buildAppCreatorEventDetails } from './app_creator.ts'
import { buildOnboardingIntentBentoEventData, parseOrgOnboardingIntent } from './org_onboarding_intent.ts'

export const APP_ONBOARDING_READY_EVENT = 'app:onboarding_ready'

type OnboardingReadyApp = Pick<
  Database['public']['Tables']['apps']['Row'],
  'app_id' | 'existing_app' | 'name' | 'need_onboarding' | 'onboarding'
>

type OnboardingReadyOrg = Pick<
  Database['public']['Tables']['orgs']['Row'],
  'id' | 'name' | 'onboarding' | 'website'
>

export function buildAppOnboardingReadyBentoEvent(
  c: Context,
  event: string,
  org: OnboardingReadyOrg,
  app: OnboardingReadyApp,
): BentoTrackingPayload | undefined {
  if (event !== APP_ONBOARDING_READY_EVENT || app.need_onboarding !== true)
    return undefined

  const creator = buildAppCreatorEventDetails(app.onboarding)
  return {
    data: {
      ...buildOnboardingIntentBentoEventData(c, parseOrgOnboardingIntent(org.onboarding), org),
      app_id: app.app_id,
      app_name: app.name,
      existing_app: app.existing_app,
      created_by_user_id: creator.created_by_user_id ?? null,
      created_by_email: creator.created_by_email ?? null,
    },
    event: APP_ONBOARDING_READY_EVENT,
    once: true,
    preferenceKey: 'onboarding',
    uniqId: `${APP_ONBOARDING_READY_EVENT}:${app.app_id}`,
  }
}
