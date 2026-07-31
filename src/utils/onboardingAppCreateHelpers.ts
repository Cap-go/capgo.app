import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { slugifyOnboardingSegment, trimTrailingDots } from '~/utils/onboardingSlug'

type AppRow = Database['public']['Tables']['apps']['Row']

export interface OnboardingAppFunctionErrorMessages {
  defaultMessage?: string
  statusMessage?: (status: number) => string
}

export interface OnboardingAppCreateInput {
  ownerOrgId: string
  baseAppId: string
  appName: string
  existingApp: boolean
  iosStoreUrl: string | null
  androidStoreUrl: string | null
  orgName?: string
  fallbackBaseId?: string
}

export type OnboardingAppCreateResult
  = | {
    ok: true
    app: AppRow
    usedAppId: string
    originalAppId: string
    wasRetried: boolean
  }
  | {
    ok: false
    reason: 'all_conflicts'
    originalAppId: string
    suggestions: string[]
  }
  | {
    ok: false
    reason: 'error'
    message: string
    error: unknown
  }

export function isAppIdConflict(error: { status?: number, message?: string } | null | undefined) {
  if (!error)
    return false

  if (error.status === 409)
    return true

  const message = error.message?.toLowerCase() || ''
  return ['duplicate', 'already exists', 'unique constraint', 'apps_pkey', 'app_id_key', 'app_id_already_exists'].some(fragment => message.includes(fragment))
}

export function buildAlternativeAppIds(
  baseId: string,
  options?: { orgName?: string, fallbackBaseId?: string },
) {
  const normalized = trimTrailingDots(baseId) || options?.fallbackBaseId || baseId
  const orgSlug = options?.orgName
    ? slugifyOnboardingSegment(options.orgName, 'prod')
    : 'prod'

  const proposals = [
    `${normalized}.app`,
    `${normalized}.mobile`,
    `${normalized}.capgo`,
    `${normalized}.${orgSlug}`,
    `${normalized}.${crypto.randomUUID().slice(0, 4)}`,
  ]

  return [...new Set(proposals.filter(candidate => candidate !== normalized))]
}

export async function readOnboardingAppFunctionError(
  error: unknown,
  messages?: OnboardingAppFunctionErrorMessages,
) {
  if (!(error instanceof FunctionsHttpError) || !(error.context instanceof Response))
    return null

  const defaultMessage = messages?.defaultMessage ?? 'Failed to create app'

  try {
    const json = await error.context.clone().json() as {
      error?: string
      message?: string
      app_id?: string
      moreInfo?: { app_id?: string, error?: string }
    }

    return {
      status: error.context.status,
      code: json.error ?? '',
      message: json.message ?? defaultMessage,
      appId: json.app_id ?? json.moreInfo?.app_id ?? '',
    }
  }
  catch {
    return {
      status: error.context.status,
      code: '',
      message: messages?.statusMessage?.(error.context.status)
        ?? `Failed to create app (${error.context.status})`,
      appId: '',
    }
  }
}

export async function createOnboardingAppWithFallbackIds(
  supabase: SupabaseClient<Database>,
  input: OnboardingAppCreateInput,
  messages?: OnboardingAppFunctionErrorMessages,
): Promise<OnboardingAppCreateResult> {
  const alternativeOptions = {
    orgName: input.orgName,
    fallbackBaseId: input.fallbackBaseId,
  }
  const candidateIds = [input.baseAppId, ...buildAlternativeAppIds(input.baseAppId, alternativeOptions)]

  for (const candidateId of candidateIds) {
    const { data, error } = await supabase.functions.invoke('app', {
      method: 'POST',
      body: {
        owner_org: input.ownerOrgId,
        app_id: candidateId,
        name: input.appName,
        need_onboarding: true,
        existing_app: input.existingApp,
        ios_store_url: input.iosStoreUrl,
        android_store_url: input.androidStoreUrl,
      },
    })

    if (!error && data?.app_id) {
      return {
        ok: true,
        app: data as AppRow,
        usedAppId: candidateId,
        originalAppId: candidateIds[0],
        wasRetried: candidateId !== candidateIds[0],
      }
    }

    const functionError = await readOnboardingAppFunctionError(error, messages)
    const isConflict = isAppIdConflict({
      status: functionError?.status ?? (error as { status?: number } | null | undefined)?.status,
      message: `${functionError?.code ?? ''} ${functionError?.message ?? (error as { message?: string } | null | undefined)?.message ?? ''}`,
    })

    if (isConflict)
      continue

    return {
      ok: false,
      reason: 'error',
      message: functionError?.message ?? messages?.defaultMessage ?? 'Failed to create app',
      error: error ?? new Error(functionError?.message ?? 'Failed to create app'),
    }
  }

  return {
    ok: false,
    reason: 'all_conflicts',
    originalAppId: candidateIds[0],
    suggestions: buildAlternativeAppIds(candidateIds[0], alternativeOptions),
  }
}
