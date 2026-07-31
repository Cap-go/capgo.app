<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { Capacitor } from '@capacitor/core'
import { storeToRefs } from 'pinia'
import { computed, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheckCircle from '~icons/lucide/check-circle'
import CreditsCta from '~/components/CreditsCta.vue'
import RbacPermissionOnlyModal from '~/components/RbacPermissionOnlyModal.vue'
import { formatIncludedThenPrice } from '~/services/creditPricing'
import { formatNumberValue } from '~/services/formatLocale'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { getAffonsoReferral, getDatafastAttribution, openCheckout } from '~/services/stripe'
import { getCreditUnitPricing, getCurrentPlanNameOrg, useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { sendEvent } from '~/services/tracking'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const mainStore = useMainStore()
const displayStore = useDisplayStore()
displayStore.NavTitle = t('plans')

// const isUsageLoading = ref(false)
const initialLoad = ref(false)
const thankYouPage = ref(false)
const isSubscribeLoading = ref<Array<boolean>>([])
const segmentVal = ref<'m' | 'y'>('y')
const isYearly = computed(() => segmentVal.value === 'y')
const route = useRoute()
const router = useRouter()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()
const isMobile = isNativeAppStoreContext()

// Modal state for non-admin access
const showAdminModal = ref(false)

const { currentOrganization } = storeToRefs(organizationStore)
const creditUnitPrices = ref<Partial<Record<Database['public']['Enums']['credit_metric_type'], number>>>({})

interface PlanFeature {
  label: string
  showCreditPricingLink?: boolean
}

function planFeature(label: string, showCreditPricingLink = false): PlanFeature {
  return { label, showCreditPricingLink }
}

const planFeatureLabelKeysByPlan: Record<string, string[]> = {
  solo: ['plan-feature-community-support-discord'],
  maker: ['plan-feature-priority-plugin-bug-fixes'],
  team: ['plan-feature-priority-plugin-bug-fixes', 'plan-feature-priority-email-support'],
  enterprise: [
    'plan-feature-priority-plugin-bug-fixes',
    'plan-feature-priority-email-support',
    'plan-feature-custom-domain',
    'plan-feature-direct-chat-support',
    'plan-feature-service-sla',
    'plan-feature-soc2-certified',
  ],
}

function planFeatures(plan: Database['public']['Tables']['plans']['Row']) {
  // Convert build time from seconds to hours or minutes for display
  const buildTimeSeconds = plan.build_time_unit || 0
  const buildTimeHours = Math.floor(buildTimeSeconds / 3600)
  const buildTimeMinutes = Math.floor(buildTimeSeconds / 60)

  let buildTimeDisplay = ''
  if (buildTimeSeconds > 0) {
    if (buildTimeHours >= 1) {
      buildTimeDisplay = `${buildTimeHours} ${t('build-hours')}`
    }
    else {
      buildTimeDisplay = `${buildTimeMinutes} ${t('build-minutes')}`
    }
  }

  const mauFeature = creditUnitPrices.value.mau !== undefined
    ? `${formatNumberValue(plan.mau)} ${t('mau')} · ${formatIncludedThenPrice('mau', creditUnitPrices.value.mau, t)}`
    : `${formatNumberValue(plan.mau)} ${t('mau')}`

  const storageFeature = creditUnitPrices.value.storage !== undefined
    ? `${formatNumberValue(plan.storage)} ${t('plan-storage')} · ${formatIncludedThenPrice('storage', creditUnitPrices.value.storage, t)}`
    : `${formatNumberValue(plan.storage)} ${t('plan-storage')}`

  const bandwidthFeature = creditUnitPrices.value.bandwidth !== undefined
    ? `${formatNumberValue(plan.bandwidth)} ${t('plan-bandwidth')} · ${formatIncludedThenPrice('bandwidth', creditUnitPrices.value.bandwidth, t)}`
    : `${formatNumberValue(plan.bandwidth)} ${t('plan-bandwidth')}`

  const buildTimeFeature = buildTimeDisplay ? planFeature(buildTimeDisplay, true) : null
  const nativeBuildConcurrencyFeature = plan.native_build_concurrency
    ? planFeature(t('plan-native-build-concurrency', { count: formatNumberValue(plan.native_build_concurrency) }))
    : null

  const planName = plan.name?.toLowerCase() ?? ''
  const extraFeatures = (planFeatureLabelKeysByPlan[planName] ?? [])
    .map(key => planFeature(t(key)))

  return [
    planFeature(mauFeature),
    planFeature(storageFeature),
    planFeature(bandwidthFeature),
    buildTimeFeature,
    nativeBuildConcurrencyFeature,
    ...extraFeatures,
  ].filter((feature): feature is PlanFeature => !!feature)
}

function convertKey(key: string) {
  const keySplit = key.split('.')
  if (keySplit.length === 3)
    return `plan-${keySplit[1]}`
  return key
}

const currentPlan = ref<Database['public']['Tables']['plans']['Row'] | undefined>(undefined)
const currentPlanSuggest = ref<Database['public']['Tables']['plans']['Row'] | undefined>(undefined)

watch(() => main.bestPlan, (newBestPlan) => {
  currentPlanSuggest.value = mainStore.plans.find(plan => plan.name === newBestPlan)
})

const isTrial = computed(() => currentOrganization?.value ? (!currentOrganization?.value.paying && (currentOrganization?.value.trial_left ?? 0) > 0) : false)

// Credits-only org: has credits but no active subscription and no trial remaining.
// These orgs use pay-as-you-go credits as their primary payment method.
const isCreditsOnly = computed(() => {
  const org = currentOrganization?.value
  if (!org)
    return false
  return !org.paying && (org.trial_left ?? 0) <= 0 && (org.credit_available ?? 0) > 0
})

function isSafariBrowser() {
  if (Capacitor.getPlatform() !== 'web')
    return false
  if (typeof navigator === 'undefined')
    return false
  const ua = navigator.userAgent
  return /Version\/[\d.]+/.test(ua) && /Safari\//.test(ua) && !/Chrome|CriOS|FxiOS|OPiOS|Edg|Chromium/.test(ua)
}

async function prefetchStripeCheckoutUrl(plan: Database['public']['Tables']['plans']['Row'], isYear: boolean) {
  if (!plan.stripe_id)
    return
  const supabase = useSupabase()
  const session = await supabase.auth.getSession()
  if (!session)
    return

  const successUrl = `${window.location.href}?success=1`
  const cancelUrl = `${window.location.href}?cancel=1`
  const datafastAttribution = await getDatafastAttribution()
  const affonsoReferral = await getAffonsoReferral()
  try {
    const resp = await supabase.functions.invoke('private/stripe_checkout', {
      body: JSON.stringify({
        priceId: plan.stripe_id,
        successUrl,
        cancelUrl,
        recurrence: isYear ? 'year' : 'month',
        orgId: currentOrganization.value?.gid ?? '',
        attributionId: datafastAttribution.visitorId,
        datafastVisitorId: datafastAttribution.visitorId,
        datafastSessionId: datafastAttribution.sessionId,
        affonsoReferral,
      }),
    })

    if (!resp.error && resp.data?.url)
      return resp.data.url as string
    return undefined
  }
  catch {
    return undefined
  }
}

function trackPlanCheckoutStarted(plan: Database['public']['Tables']['plans']['Row'], isYear: boolean, checkoutSource: string) {
  const orgId = currentOrganization.value?.gid
  if (!orgId || !plan.stripe_id)
    return

  sendEvent({
    channel: 'usage',
    event: 'Checkout Started',
    icon: '💳',
    org_id: orgId,
    tracking_version: 2,
    notify: false,
    tags: {
      product_id: plan.stripe_id,
      plan_name: plan.name,
      recurrence: isYear ? 'year' : 'month',
      checkout_source: checkoutSource,
      current_plan_name: currentPlan.value?.name ?? '',
      plan_price: isYear ? plan.price_y : plan.price_m,
      plan_price_monthly: plan.price_m,
      plan_price_yearly: plan.price_y,
    },
  }).catch()
}

async function openSafariStripeCheckout(plan: Database['public']['Tables']['plans']['Row'], isYear: boolean) {
  const url = await prefetchStripeCheckoutUrl(plan, isYear)
  if (!url) {
    toast.error('Cannot get your checkout')
    return false
  }

  dialogStore.openDialog({
    title: t('open-in-new-tab'),
    description: 'This will open Stripe to complete checkout.',
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-confirm'),
        id: 'confirm-button',
        role: 'primary',
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
        handler: () => trackPlanCheckoutStarted(plan, isYear, 'safari_confirm'),
      },
    ],
  })

  const dismissedByCancel = await dialogStore.onDialogDismiss()
  return !dismissedByCancel
}

async function openChangePlan(plan: Database['public']['Tables']['plans']['Row'], index: number) {
  // Show the permission modal instead of blocking when the user can't manage billing.
  const orgId = currentOrganization.value?.gid
  if (!orgId || !(await checkPermissions('org.update_billing', { orgId }))) {
    showAdminModal.value = true
    return
  }

  // get the current url
  isSubscribeLoading.value[index] = true
  if (plan.stripe_id) {
    const checkoutIsYearly = plan.price_y === plan.price_m ? false : isYearly.value
    if (isSafariBrowser()) {
      const shouldContinue = await openSafariStripeCheckout(plan, checkoutIsYearly)
      if (!shouldContinue) {
        isSubscribeLoading.value[index] = false
        return
      }
    }
    else {
      const didOpenCheckout = await openCheckout(plan.stripe_id, `${globalThis.location.href}?success=1`, `${globalThis.location.href}?cancel=1`, checkoutIsYearly, currentOrganization?.value?.gid ?? '')
      if (didOpenCheckout)
        trackPlanCheckoutStarted(plan, checkoutIsYearly, 'direct')
    }
  }
  isSubscribeLoading.value[index] = false
}

function getPrice(plan: Database['public']['Tables']['plans']['Row'], t: 'm' | 'y'): number {
  if (t === 'm' || plan.price_y === plan.price_m) {
    return plan.price_m
  }
  else {
    const p = plan.price_y
    return Math.round(p / 12)
  }
}

function isYearlyPlan(plan: Database['public']['Tables']['plans']['Row'], t: 'm' | 'y'): boolean {
  return t === 'y'
}

async function loadCreditPricing(orgId?: string) {
  creditUnitPrices.value = await getCreditUnitPricing(orgId)
}

async function loadData(initial: boolean) {
  if (!initialLoad.value && !initial)
    return

  await organizationStore.awaitInitialLoad()

  const orgToLoad = currentOrganization.value
  const orgId = orgToLoad?.gid
  if (!orgId)
    throw new Error('Cannot get current org id')

  await Promise.all([
    loadCreditPricing(orgId),
    getCurrentPlanNameOrg(orgId).then((res) => {
      console.log('getCurrentPlanNameOrg', res)
      currentPlan.value = main.plans.find(plan => plan.name === res)
    }),
  ])
  initialLoad.value = true
}

// Pick the org with the most apps where the user can actually manage billing.
// Used as a fallback when the current org's billing is not accessible.
async function findBillableFallbackOrg() {
  const candidates = [...organizationStore.getAllOrgs()]
    .map(([_, org]) => org)
    .sort((a, b) => b.app_count - a.app_count)
  for (const org of candidates) {
    if (await checkPermissions('org.update_billing', { orgId: org.gid }))
      return org
  }
  return undefined
}
watch(currentOrganization, async (newOrg, prevOrg) => {
  if (newOrg) {
    // Check permission directly instead of relying on computedAsync default
    const hasUpdateBillingPermission = await checkPermissions('org.update_billing', { orgId: newOrg.gid })

    if (!hasUpdateBillingPermission) {
      if (!initialLoad.value) {
        const fallbackOrg = await findBillableFallbackOrg()
        if (fallbackOrg) {
          organizationStore.setCurrentOrganization(fallbackOrg.gid)
          return
        }
      }

      dialogStore.openDialog({
        title: t('cannot-view-plans'),
        description: `${t('plans-super-only')}`,
        buttons: [
          {
            text: t('ok'),
          },
        ],
      })
      await dialogStore.onDialogDismiss()
      if (!prevOrg)
        router.push('/apps')
      else
        organizationStore.setCurrentOrganization(prevOrg.gid)
      return
    }
  }

  await loadData(false)
  segmentVal.value = currentOrganization.value?.is_yearly ? 'y' : 'm'

  // isSubscribeLoading.value.fill(false, 0, plans.value.length)
})

watchEffect(async () => {
  if (route.path === '/settings/organization/plans') {
    if (isMobile) {
      router.replace('/settings/organization/usage')
      return
    }

    // if success is in url params show modal success plan setup
    if (route.query.success) {
      // toast.success(t('usage-success'))
      thankYouPage.value = true
    }
    else if (main.user?.id) {
      if (route.query.oid && typeof route.query.oid === 'string') {
        await organizationStore.awaitInitialLoad()
        organizationStore.setCurrentOrganization(route.query.oid)
      }

      // Check permission on initial load
      if (currentOrganization.value) {
        const hasUpdateBillingPermission = await checkPermissions('org.update_billing', { orgId: currentOrganization.value.gid })

        if (!hasUpdateBillingPermission) {
          const fallbackOrg = await findBillableFallbackOrg()
          if (fallbackOrg) {
            organizationStore.setCurrentOrganization(fallbackOrg.gid)
            return
          }

          dialogStore.openDialog({
            title: t('cannot-view-plans'),
            description: `${t('plans-super-only')}`,
            buttons: [
              {
                text: t('ok'),
              },
            ],
          })
          await dialogStore.onDialogDismiss()
          router.push('/apps')
          return
        }
      }

      loadData(true)
      const orgId = currentOrganization.value?.gid
      if (orgId) {
        sendEvent({
          channel: 'usage',
          event: 'User visit',
          icon: '💳',
          org_id: orgId,
          tracking_version: 2,
          notify: false,
        }).catch()
      }
    }
  }
})
// create function to check button status
function buttonName(p: Database['public']['Tables']['plans']['Row']) {
  if (isMobile)
    return t('check-on-web')
  if (currentPlan.value?.name === p.name && currentOrganization.value?.paying && currentOrganization.value?.is_yearly === isYearly.value) {
    return t('Current')
  }
  if (isTrial.value || organizationStore.currentOrganizationFailed) {
    return t('plan-upgrade')
  }
  return p.price_m >= (currentPlan.value?.price_m ?? 0) ? (t('plan-upgrade-v2')) : (t('downgrade'))
}

function isDisabled(plan: Database['public']['Tables']['plans']['Row']) {
  // Disabled if: current plan (already subscribed) or mobile
  return (currentPlan.value?.name === plan.name && currentOrganization.value?.paying && currentOrganization.value?.is_yearly === isYearly.value) || isMobile
}

function isRecommended(p: Database['public']['Tables']['plans']['Row']) {
  return currentPlanSuggest.value?.name === p.name && (currentPlanSuggest.value?.price_m ?? 0) > (currentPlan.value?.price_m ?? 0)
}
function buttonStyle(p: Database['public']['Tables']['plans']['Row']) {
  if (isDisabled(p)) {
    return 'cursor-not-allowed bg-gray-500 dark:bg-gray-400 text-white'
  }
  if (isRecommended(p)) {
    return 'cursor-pointer bg-blue-600 hover:bg-blue-700 focus:ring-blue-700 text-white'
  }
  return 'cursor-pointer bg-black dark:bg-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black'
}
</script>

<template>
  <div class="flex flex-col bg-white border shadow-lg md:p-8 md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900" :class="thankYouPage ? 'pb-0' : 'pb-8 md:pb-0'">
    <div v-if="!thankYouPage" class="flex flex-col w-full h-full">
      <!-- Header Section -->
      <div class="flex flex-col items-center justify-between gap-4 mb-6 sm:flex-row shrink-0">
        <div class="flex-1">
          <div class="flex items-center gap-3">
            <h1 class="text-3xl font-bold text-gray-900 dark:text-white">
              {{ t('plan-pricing-plans') }}
            </h1>
            <!-- Custom Plan Trigger -->
            <button
              v-if="!isMobile"
              class="items-center hidden px-3 py-1 text-xs font-medium text-blue-700 transition-colors rounded-full bg-blue-50 lg:inline-flex dark:text-blue-300 hover:bg-blue-100 dark:bg-blue-900/30"
              @click="openSupport()"
            >
              {{ t('need-more-contact-us') }}
            </button>
          </div>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('plan-desc') }}
          </p>
          <p v-if="!isMobile" class="mt-2 text-sm">
            <a class="font-medium text-blue-600 hover:underline dark:text-blue-300" href="https://capgo.app/pricing/#compare-plans">
              {{ t('plan-full-comparison-link') }}
            </a>
          </p>
        </div>

        <!-- Toggle -->
        <div class="flex items-center p-1 bg-gray-200 rounded-lg dark:bg-base-200">
          <button
            class="py-1.5 px-4 text-sm font-medium rounded-md transition-all duration-200"
            :class="segmentVal === 'm' ? 'bg-white dark:bg-base-100 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'"
            @click="segmentVal = 'm'"
          >
            {{ t('monthly-plan') }}
          </button>
          <button
            class="flex gap-2 items-center py-1.5 px-4 text-sm font-medium rounded-md transition-all duration-200"
            :class="segmentVal === 'y' ? 'bg-white dark:bg-base-100 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'"
            @click="segmentVal = 'y'"
          >
            {{ t('yearly') }}
            <span class="py-0.5 px-1.5 text-xs font-bold text-green-600 bg-green-100 rounded-full dark:text-green-400 dark:bg-green-900/30">-20%</span>
          </button>
        </div>
      </div>

      <!-- Error Message -->
      <div v-if="organizationStore.currentOrganizationFailed" class="px-4 py-2 mb-4 font-medium text-center text-white bg-red-500 rounded-lg shrink-0">
        {{ t('plan-failed') }}
      </div>

      <!-- Credits CTA: shows info banner for credits-only orgs, upsell CTA for others -->
      <CreditsCta v-if="!isMobile" class="mb-6 shrink-0" :credits-only="isCreditsOnly" />

      <!-- Expert as a Service CTA -->
      <div v-if="!isMobile" class="mb-6 shrink-0">
        <div class="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/70 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-slate-900 dark:text-white">
              {{ t('expert-service-title') }}
            </p>
            <p class="mt-1 max-w-3xl text-xs leading-5 text-slate-600 dark:text-slate-300">
              {{ t('expert-service-desc') }}
            </p>
          </div>
          <a
            class="d-btn d-btn-sm h-auto min-h-10 w-full shrink-0 justify-center gap-2 whitespace-nowrap rounded-lg border-none bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 sm:w-auto"
            href="https://capgo.app/premium-support/"
            rel="noopener noreferrer"
            target="_blank"
          >
            {{ t('expert-service-cta') }}
            <IconArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>

      <!-- Plans Grid -->
      <div class="grid content-start min-h-0 grid-cols-1 gap-4 p-1 overflow-y-auto md:grid-cols-2 xl:grid-cols-4 grow">
        <div
          v-for="(p, index) in mainStore.plans"
          :key="p.price_m"
          data-test="plan-card"
          :data-plan-name="p.name"
          class="relative flex flex-col p-5 overflow-hidden transition-all duration-200 bg-gray-100 border rounded-2xl group dark:bg-base-200"
          :class="[
            // Don't highlight the plan card for credits-only orgs — they are not actually
            // on any plan, and highlighting Solo (the fallback) would be misleading.
            p.name === currentPlan?.name && !isCreditsOnly ? 'border-2 border-blue-500' : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700',
            isRecommended(p) ? 'shadow-lg shadow-blue-500/10' : 'shadow-sm',
          ]"
        >
          <!-- Recommended Badge -->
          <div v-if="isRecommended(p)" class="absolute inset-x-0 top-0 h-1 from-blue-500 to-indigo-500 bg-linear-to-r" />
          <div v-if="isRecommended(p)" class="absolute top-3 right-3">
            <span class="inline-flex items-center py-0.5 px-2.5 text-xs font-medium text-blue-800 bg-blue-100 rounded-full dark:text-blue-200 dark:bg-blue-900/50">
              {{ t('recommended') }}
            </span>
          </div>

          <!-- Plan Header -->
          <div class="mb-4 shrink-0">
            <h3 class="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
              {{ p.name }}
              <span v-if="isTrial && currentPlanSuggest?.name === p.name" class="py-0.5 px-2 text-xs font-medium text-white bg-blue-600 rounded-full">
                {{ t('free-trial') }}
              </span>
            </h3>
            <p class="h-8 mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
              {{ t(convertKey(p.description)) }}
            </p>
          </div>

          <!-- Price -->
          <div class="mb-6 shrink-0">
            <div class="flex items-baseline">
              <span class="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white">
                ${{ getPrice(p, segmentVal) }}
              </span>
              <span class="ml-1 text-sm font-medium text-gray-500 dark:text-gray-400">/{{ t('mo') }}</span>
            </div>
            <p v-if="isYearlyPlan(p, segmentVal)" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ p.price_m !== p.price_y ? t('billed-annually-at') : t('billed-monthly-at') }} ${{ p.price_y }}
            </p>
          </div>

          <!-- Action Button -->
          <button
            data-test="plan-action-button"
            :class="buttonStyle(p)"
            class="flex items-center justify-center w-full gap-2 px-4 py-2 mb-6 text-sm font-semibold transition-all duration-200 rounded-lg shadow-sm shrink-0"
            :disabled="isDisabled(p)"
            @click="openChangePlan(p, index)"
          >
            <svg v-if="isSubscribeLoading[index]" class="w-4 h-4 text-white animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            {{ buttonName(p) }}
          </button>

          <!-- Features -->
          <div class="px-2 -mx-2 overflow-y-auto grow custom-scrollbar">
            <ul class="space-y-3">
              <li v-for="(f, indexx) in planFeatures(p)" :key="indexx" class="flex items-start gap-3 text-sm">
                <svg class="w-5 h-5 text-green-500 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
                <span class="leading-tight text-gray-600 dark:text-gray-300">
                  {{ f.label }}
                  <router-link
                    v-if="f.showCreditPricingLink"
                    class="ml-1 font-medium text-blue-600 hover:underline dark:text-blue-300"
                    to="/settings/organization/credits#credit-pricing"
                  >
                    {{ t('credits-pricing-after-included-link') }}
                  </router-link>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Footer / Contact -->
      <div v-if="!isMobile" class="mt-4 text-xs text-center text-gray-500 dark:text-gray-400 shrink-0">
        {{ t('plan-page-warn').replace('%ORG_NAME%', currentOrganization?.name ?? '') }}
        <a class="text-blue-600 hover:underline" href="https://capgo.app/docs/docs/webapp/payment/">{{ t('plan-page-warn-2') }}</a>
      </div>
    </div>

    <!-- Thank You Page -->
    <div v-else class="flex w-full min-h-[calc(100dvh-10rem)] items-center justify-center overflow-hidden rounded-lg bg-linear-to-br from-slate-50 via-white to-blue-50 px-4 py-8 dark:from-base-300 dark:via-gray-900 dark:to-slate-950 sm:min-h-[560px] sm:px-6 md:px-8">
      <section aria-live="polite" class="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
        <div class="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-blue-100 text-blue-600 ring-8 ring-blue-50 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/10 sm:h-24 sm:w-24">
          <IconCheckCircle class="h-11 w-11 sm:h-12 sm:w-12" aria-hidden="true" />
        </div>

        <h2 class="max-w-xl text-2xl font-bold leading-tight text-gray-900 dark:text-white sm:text-3xl">
          {{ t('thank-you-for-sub') }}
        </h2>

        <p class="mt-4 max-w-xl text-base leading-7 text-gray-600 dark:text-gray-300">
          {{ t('usage-success') }}
        </p>

        <div class="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          <router-link to="/apps" class="d-btn d-btn-primary min-h-12 w-full rounded-lg px-5 text-base font-semibold sm:w-auto">
            <span>{{ t('use-capgo') }}</span>
            <IconArrowRight class="h-4 w-4" aria-hidden="true" />
          </router-link>

          <router-link to="/settings/organization/usage" class="d-btn d-btn-ghost min-h-12 w-full rounded-lg px-5 text-base font-semibold text-gray-700 dark:text-gray-200 sm:w-auto">
            {{ t('usage') }}
          </router-link>
        </div>
      </section>
    </div>

    <!-- Permission modal shown when the user can't manage billing -->
    <RbacPermissionOnlyModal
      v-if="showAdminModal"
      :title="t('billing-access-required')"
      permission="org.update_billing"
      @click="showAdminModal = false"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
        </route>
