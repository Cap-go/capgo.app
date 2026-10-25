<script setup lang="ts">
/**
 * TrialCardPrompt Component
 *
 * Asks trial organizations to save a card right after an activation milestone:
 * the first device that installed an update, or the first successful native build.
 * The card schedules the plan picked during onboarding to start when the trial ends;
 * nothing is charged before then and the trial keeps running. The user can switch
 * Solo / Maker / Team before confirming.
 *
 * Visibility conditions:
 * - Stripe billing is enabled and external purchase flows are allowed
 * - The organization is on trial (not paying, trial_left > 0)
 * - The user can manage org billing (org.update_billing)
 * - An app of the organization reached a milestone the user was not asked about yet,
 *   or the page was opened with `?trial_card=1&oid=<org>` (CLI agent notices)
 * - The org has an onboarding plan to start and it is not scheduled yet
 */

import type { TrialPlan, TrialPlanOption } from '~/services/stripe'
import type { TrialCardMilestone } from '~/utils/trialCardPrompt'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconLock from '~icons/heroicons/lock-closed'
import BillingModal from '~/components/billing/BillingModal.vue'
import CardFormModal from '~/components/billing/CardFormModal.vue'
import TrialPlanPicker from '~/components/billing/TrialPlanPicker.vue'
import { getLocalConfig, stripeEnabled } from '~/services/console'
import { formatLocalDate } from '~/services/date'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { pushEvent } from '~/services/posthog'
import { formatStripeAmount, getTrialPlan, scheduleTrialPlan } from '~/services/stripe'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'
import { readTrialCardDeepLink, TRIAL_CARD_PARAM } from '~/utils/billingDeepLinks'
import {
  getReachedTrialCardMilestones,
  markTrialCardMilestonesHandled,
  pickTrialCardMilestone,
  readHandledTrialCardMilestones,
} from '~/utils/trialCardPrompt'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const organizationStore = useOrganizationStore()
const config = getLocalConfig()
const hideExternalPurchaseFlows = isNativeAppStoreContext()

interface ActivePrompt {
  // Pinned when shown so switching organization while it is open cannot misattribute it.
  orgId: string
  // null when opened from the deep link rather than a milestone.
  milestone: TrialCardMilestone | null
  reached: TrialCardMilestone[]
  trialDaysLeft: number
  plan: TrialPlan
  plans: TrialPlanOption[]
  hasCard: boolean
}

const prompt = ref<ActivePrompt | null>(null)
const step = ref<'ask' | 'card' | null>(null)
const selectedProductId = ref('')
const isScheduling = ref(false)
let lookupRun = 0

const currentOrg = computed(() => organizationStore.currentOrganization)
const orgId = computed(() => {
  const org = currentOrg.value
  if (!org || isPendingOrganizationInvite(org))
    return ''
  return org.gid
})
const isTrial = computed(() => {
  const org = currentOrg.value
  return !!org && !org.paying && (org.trial_left ?? 0) > 0
})
const reachedMilestones = computed(() => orgId.value ? getReachedTrialCardMilestones(organizationStore.getAppsByOrgId(orgId.value)) : [])
// Onboarding pages run their own success flow; ask once the user lands on the dashboard.
const isOnboardingRoute = computed(() => route.path === '/onboarding'
  || route.path.startsWith('/onboarding/')
  || /^\/app\/new\/?$/.test(route.path)
  || /^\/app\/[^/]+\/getting-started\/?$/.test(route.path))
const pendingMilestone = computed(() => {
  if (!orgId.value || !isTrial.value || isOnboardingRoute.value)
    return null
  return pickTrialCardMilestone(reachedMilestones.value, readHandledTrialCardMilestones(orgId.value))
})
// Org the deep link asked about; cleared once a prompt opens. It skips only the milestone check.
const deepLinkOrgId = ref('')
const isDeepLinked = computed(() => !!orgId.value && deepLinkOrgId.value === orgId.value && isTrial.value && !isOnboardingRoute.value)

watch(() => route.query[TRIAL_CARD_PARAM], async () => {
  const link = readTrialCardDeepLink(route.query)
  if (!link)
    return
  void router.replace({ query: { ...route.query, [TRIAL_CARD_PARAM]: undefined } })
  await organizationStore.awaitInitialLoad()
  if (link.orgId)
    organizationStore.setCurrentOrganization(link.orgId)
  deepLinkOrgId.value = link.orgId ?? orgId.value
}, { immediate: true })

const selectedOption = computed(() => {
  const options = prompt.value?.plans ?? []
  return options.find(option => option.productId === selectedProductId.value)
    ?? options.find(option => option.planName === prompt.value?.plan.planName)
    ?? null
})
const selectedPlanName = computed(() => selectedOption.value?.planName ?? prompt.value?.plan.planName ?? '')
const planPrice = computed(() => {
  if (selectedOption.value)
    return formatStripeAmount(selectedOption.value.amount, selectedOption.value.currency)
  return prompt.value ? formatStripeAmount(prompt.value.plan.amount, prompt.value.plan.currency) : ''
})
const planDate = computed(() => prompt.value ? formatLocalDate(prompt.value.plan.startsAt) : '')
const title = computed(() => {
  if (prompt.value && !prompt.value.milestone)
    return t('trial-plan-offer-title', { plan: selectedPlanName.value })
  return prompt.value?.milestone === 'builder' ? t('trial-card-prompt-title-builder') : t('trial-card-prompt-title-ota')
})
const showPicker = computed(() => (prompt.value?.plans.length ?? 0) > 1)

function track(event: string) {
  if (!prompt.value)
    return
  pushEvent(event, config.apiHost, {
    org_id: prompt.value.orgId,
    source: prompt.value.milestone ? 'milestone' : 'deep_link',
    milestone: prompt.value.milestone,
    trial_days_left: prompt.value.trialDaysLeft,
    plan: selectedPlanName.value,
  })
}

watch([orgId, pendingMilestone, isDeepLinked, () => !!stripeEnabled.value], async ([id, pending, deepLinked, enabled]) => {
  const run = ++lookupRun
  if (step.value)
    return
  if (!id || !(pending || deepLinked) || !enabled || hideExternalPurchaseFlows)
    return
  if (!await checkPermissions('org.update_billing', { orgId: id }) || run !== lookupRun)
    return
  let trial: Awaited<ReturnType<typeof getTrialPlan>>
  try {
    trial = await getTrialPlan(id)
  }
  catch {
    // Billing unavailable for this org (no customer, region not configured): skip quietly.
    return
  }
  if (run !== lookupRun)
    return
  // Every milestone reached so far counts as asked: one prompt per new milestone, not a backlog.
  const reached = reachedMilestones.value.map(entry => entry.milestone)
  if (!trial.plan || trial.plan.scheduled) {
    markTrialCardMilestonesHandled(id, reached)
    return
  }
  const plans = trial.plans ?? []
  prompt.value = {
    orgId: id,
    milestone: deepLinked ? null : pending,
    reached,
    trialDaysLeft: currentOrg.value?.trial_left ?? 0,
    plan: trial.plan,
    plans,
    hasCard: !!trial.card,
  }
  selectedProductId.value = trial.plan.productId
    || plans.find(option => option.planName === trial.plan!.planName)?.productId
    || plans[0]?.productId
    || ''
  step.value = 'ask'
  deepLinkOrgId.value = ''
  track('trial_card_prompt_shown')
}, { immediate: true })

// A failed schedule keeps the milestones pending so the prompt comes back next visit.
function close(event: string, handled = true) {
  track(event)
  if (prompt.value && handled)
    markTrialCardMilestonesHandled(prompt.value.orgId, prompt.value.reached)
  step.value = null
  prompt.value = null
  selectedProductId.value = ''
}

function dismiss() {
  if (isScheduling.value)
    return
  close(step.value === 'card' ? 'trial_card_prompt_card_closed' : 'trial_card_prompt_dismissed')
}

async function startPlan() {
  const current = prompt.value
  if (!current || isScheduling.value)
    return
  isScheduling.value = true
  try {
    const { plan } = await scheduleTrialPlan(current.orgId, selectedProductId.value || undefined)
    toast.success(t('trial-plan-scheduled', { plan: plan.planName, date: formatLocalDate(plan.startsAt) }))
    close('trial_card_prompt_plan_scheduled')
  }
  catch (error) {
    console.error('Cannot schedule trial plan', error)
    toast.error(t('trial-plan-schedule-error'))
    close('trial_card_prompt_schedule_failed', false)
  }
  finally {
    isScheduling.value = false
  }
}

function accept() {
  track('trial_card_prompt_add_clicked')
  if (prompt.value?.hasCard)
    void startPlan()
  else
    step.value = 'card'
}

function onCardSaved() {
  track('trial_card_prompt_card_saved')
  void startPlan()
}
</script>

<template>
  <BillingModal
    v-if="step === 'ask'"
    :title="title"
    :busy="isScheduling"
    @close="dismiss"
  >
    <div v-if="prompt" class="flex items-start gap-3">
      <IconCheckCircle class="mt-0.5 h-6 w-6 shrink-0 text-green-500" aria-hidden="true" />
      <div class="space-y-2 text-sm leading-6 text-slate-700 dark:text-slate-200">
        <p>{{ t('trial-card-prompt-message') }}</p>
        <p class="font-medium">
          {{ t('trial-card-prompt-plan', { plan: selectedPlanName, price: planPrice, date: planDate }) }}
        </p>
        <p class="text-slate-600 dark:text-slate-300">
          {{ t('trial-card-prompt-no-charge', { days: prompt.trialDaysLeft }, prompt.trialDaysLeft) }}
        </p>
      </div>
    </div>
    <TrialPlanPicker
      v-if="prompt && showPicker"
      v-model="selectedProductId"
      :options="prompt.plans"
      :disabled="isScheduling"
    />
    <p class="mt-4 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <IconLock class="h-4 w-4 shrink-0" />
      {{ t('billing-card-secure') }}
    </p>
    <div class="mt-6 flex flex-wrap justify-end gap-2">
      <button type="button" class="d-btn d-btn-ghost" :disabled="isScheduling" data-test="trial-card-prompt-later" @click="dismiss">
        {{ t('trial-card-prompt-later') }}
      </button>
      <button type="button" class="d-btn d-btn-primary" :disabled="isScheduling" data-test="trial-card-prompt-add" @click="accept">
        <span v-if="isScheduling" class="d-loading d-loading-spinner d-loading-sm" />
        {{ prompt?.hasCard ? t('trial-plan-start', { plan: selectedPlanName }) : t('trial-card-prompt-add') }}
      </button>
    </div>
  </BillingModal>
  <CardFormModal
    v-else-if="step === 'card' && prompt"
    :org-id="prompt.orgId"
    mode="setup"
    @close="dismiss"
    @saved="onCardSaved"
  />
</template>
