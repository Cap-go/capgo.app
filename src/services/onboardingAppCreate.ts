import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import type { OnboardingAppDraft } from '~/utils/onboardingAppDraft'
import {
  createOnboardingAppWithFallbackIds,
} from '~/utils/onboardingAppCreateHelpers'

type AppRow = Database['public']['Tables']['apps']['Row']

interface CreateOnboardingAppResult {
  app: AppRow
  appIdFeedback?: string
}

async function uploadIconFromDraft(
  supabase: SupabaseClient<Database>,
  ownerOrgId: string,
  appId: string,
  draft: OnboardingAppDraft,
) {
  const iconSource = draft.iconDataUrl || draft.storeIconDataUrl
  if (!iconSource)
    return

  try {
    let blob: Blob
    if (iconSource.startsWith('data:')) {
      const [header, payload = ''] = iconSource.split(',', 2)
      const contentType = /^data:([^;]+)/.exec(header)?.[1] ?? 'image/png'
      if (!payload)
        return

      const binary = atob(payload)
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
      blob = new Blob([bytes], { type: contentType })
    }
    else {
      const response = await fetch(iconSource)
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      if (!response.ok || !contentType.startsWith('image/'))
        return
      blob = await response.blob()
    }

    const iconPath = `org/${ownerOrgId}/${appId}/icon`
    const { error: uploadError } = await supabase.storage
      .from('images')
      .upload(iconPath, blob, {
        upsert: true,
        contentType: blob.type || 'image/png',
      })

    if (uploadError) {
      console.error('Cannot upload onboarding app icon', uploadError)
      return
    }

    await supabase
      .from('apps')
      .update({ icon_url: iconPath })
      .eq('app_id', appId)
  }
  catch (error) {
    console.error('Cannot process onboarding app icon', error)
  }
}

export async function createOnboardingAppFromDraft(
  supabase: SupabaseClient<Database>,
  ownerOrgId: string,
  draft: OnboardingAppDraft,
  orgName?: string,
): Promise<CreateOnboardingAppResult> {
  const createResult = await createOnboardingAppWithFallbackIds(supabase, {
    ownerOrgId,
    baseAppId: draft.appId,
    appName: draft.appName,
    existingApp: draft.existingApp,
    iosStoreUrl: draft.iosStoreUrl,
    androidStoreUrl: draft.androidStoreUrl,
    orgName,
  })

  if (createResult.ok === false) {
    if (createResult.reason === 'all_conflicts')
      throw new Error(`App ID ${createResult.originalAppId} is already used.`)

    throw new Error(createResult.message)
  }

  const { app: responseData, usedAppId, originalAppId, wasRetried } = createResult
  const appIdFeedback = wasRetried
    ? `App ID ${originalAppId} was already taken, so Capgo switched to ${usedAppId}.`
    : undefined

  await uploadIconFromDraft(supabase, ownerOrgId, responseData.app_id, draft)

  const { data: refreshed } = await supabase
    .from('apps')
    .select()
    .eq('app_id', responseData.app_id)
    .single()

  return { app: refreshed ?? responseData, appIdFeedback }
}
