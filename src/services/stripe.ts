import type { ComposerTranslation } from 'vue-i18n'
import { Capacitor } from '@capacitor/core'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useSupabase } from './supabase'

async function presentActionSheetOpen(url: string) {
  const { t } = useI18n()
  const dialogStore = useDialogV2Store()

  dialogStore.openDialog({
    title: t('open-in-new-tab'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('continue'),
        id: 'continue-button',
        handler: async () => {
          window.open(url, '_blank')
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}
export function openBlank(link: string) {
  console.log('openBlank', link)
  if (Capacitor.getPlatform() === 'ios') {
    presentActionSheetOpen(link)
    return true
  }
  return Boolean(globalThis.open(link, '_blank'))
}
export async function openPortal(orgId: string, t: ComposerTranslation) {
  let url = ''
  const supabase = useSupabase()
  const dialogStore = useDialogV2Store()

  const session = await supabase.auth.getSession()
  if (!session)
    return

  // datafast_visitor_id

  const prem = supabase.functions.invoke('private/stripe_portal', {
    body: JSON.stringify({ callbackUrl: globalThis.location.href, orgId }),
  }).then(({ data }) => {
    if (data?.url) {
      url = data.url
    }
  })

  dialogStore.openDialog({
    title: t('open-your-portal'),
    description: t('stripe-billing-portal-will-be-opened-in-a-new-tab'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        id: 'confirm-button',
        role: 'primary',
        handler: async () => {
          await prem
          if (url)
            openBlank(url)
          else
            toast.error('Cannot open your portal')
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function getCookieValue(name: string) {
  if ('cookieStore' in globalThis && globalThis.cookieStore)
    return (await globalThis.cookieStore.get(name))?.value

  if (typeof document === 'undefined')
    return undefined

  const encodedName = `${encodeURIComponent(name)}=`
  const cookie = document.cookie.split('; ').find(cookie => cookie.startsWith(encodedName))
  return cookie ? decodeURIComponent(cookie.slice(encodedName.length)) : undefined
}

export async function getDatafastAttribution() {
  return {
    visitorId: await getCookieValue('datafast_visitor_id'),
    sessionId: await getCookieValue('datafast_session_id'),
  }
}

export async function getAffonsoReferral() {
  try {
    const referral = await getCookieValue('affonso_referral')
    // Stripe metadata values are capped at 500 characters.
    return referral && referral.length <= 500 ? referral : ''
  }
  catch {
    return ''
  }
}

export async function openCheckout(priceId: string, successUrl: string, cancelUrl: string, isYear: boolean, orgId: string) {
  //   console.log('openCheckout')
  const supabase = useSupabase()
  const session = await supabase.auth.getSession()
  if (!session)
    return false
  const datafastAttribution = await getDatafastAttribution()
  const affonsoReferral = await getAffonsoReferral()
  try {
    const resp = await supabase.functions.invoke('private/stripe_checkout', {
      body: JSON.stringify({
        priceId,
        successUrl,
        cancelUrl,
        recurrence: isYear ? 'year' : 'month',
        orgId,
        attributionId: datafastAttribution.visitorId,
        datafastVisitorId: datafastAttribution.visitorId,
        datafastSessionId: datafastAttribution.sessionId,
        affonsoReferral,
      }),
    })
    if (!resp.error && resp.data?.url)
      return openBlank(resp.data.url)
    return false
  }
  catch (error) {
    console.error(error)
    toast.error('Cannot get your checkout')
    return false
  }
}

export async function startCreditTopUp(orgId: string, quantity = 100) {
  if (!orgId)
    return
  const supabase = useSupabase()
  const datafastAttribution = await getDatafastAttribution()
  const affonsoReferral = await getAffonsoReferral()
  try {
    const { data, error } = await supabase.functions.invoke('private/credits/start-top-up', {
      body: JSON.stringify({
        orgId,
        quantity,
        datafastVisitorId: datafastAttribution.visitorId,
        datafastSessionId: datafastAttribution.sessionId,
        affonsoReferral,
      }),
    })
    if (error || !data?.url) {
      console.error('Failed to start credit top-up', error ?? data)
      throw error ?? new Error('Missing checkout URL')
    }
    globalThis.location.href = data.url
  }
  catch (error) {
    console.error('Cannot start credit top-up checkout', error)
    toast.error('Cannot start credit checkout')
    throw error
  }
}

export async function completeCreditTopUp(orgId: string, sessionId?: string | null) {
  if (!orgId)
    return null

  const supabase = useSupabase()
  try {
    const { data, error } = await supabase.functions.invoke('private/credits/complete-top-up', {
      body: JSON.stringify({
        orgId,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    if (error) {
      console.error('Failed to complete credit top-up', error)
      throw error
    }
    return data?.grant ?? null
  }
  catch (error) {
    console.error('Cannot complete credit top-up', error)
    toast.error('Cannot finalize credit checkout')
    throw error
  }
}
