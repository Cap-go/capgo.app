<script setup lang="ts">
/**
 * "Start now" for a trial org: charges the saved card today for the trial plan instead of
 * waiting for the trial to end. Discloses the charge, that the rest of the trial ends, and
 * that the billing cycle restarts today (usage already recorded today stays in it).
 */

import type { BillingCard, TrialPlan } from '~/services/stripe'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconBolt from '~icons/heroicons/bolt'
import BillingModal from '~/components/billing/BillingModal.vue'
import { getCapgoApiErrorName } from '~/services/capgoApi'
import { getLocalConfig } from '~/services/console'
import { pushEvent } from '~/services/posthog'
import { formatStripeAmount, startTrialPlanNow } from '~/services/stripe'

const props = defineProps<{
  orgId: string
  plan: TrialPlan
  card: BillingCard
  trialDaysLeft: number
  source: string
}>()

const emit = defineEmits<{
  close: []
  started: [plan: TrialPlan]
  // The org can no longer start now (trial over, already subscribed), or the outcome is unknown: Billing reloads.
  stale: []
}>()

// Backend refusals that mean the offer is out of date, not that the card failed.
const STALE_ERROR_CODES = new Set(['trial_plan_unavailable', 'trial_plan_already_subscribed', 'missing_payment_method'])

const { t } = useI18n()
const config = getLocalConfig()
// Pinned to the org it was opened for; an org change closes it.
const startOrgId = props.orgId
const isStarting = ref(false)
const price = computed(() => formatStripeAmount(props.plan.amount, props.plan.currency))
const cardLabel = computed(() => `${props.card.brand.charAt(0).toUpperCase()}${props.card.brand.slice(1)} •••• ${props.card.last4}`)

function track(event: string) {
  pushEvent(event, config.apiHost, {
    org_id: startOrgId,
    source: props.source,
    plan: props.plan.planName,
    trial_days_left: props.trialDaysLeft,
  })
}

watch(() => props.orgId, (id) => {
  if (id !== startOrgId)
    emit('close')
})

// Billing reloaded and no longer offers the plan (or it changed): do not confirm an old charge.
watch(() => [props.plan.productId, props.plan.amount, props.card.id] as const, (next, previous) => {
  if (next.some((value, index) => value !== previous[index]))
    emit('close')
})

onMounted(() => track('trial_plan_start_now_shown'))

function keepTrial() {
  if (isStarting.value)
    return
  track('trial_plan_start_now_declined')
  emit('close')
}

async function startNow() {
  if (isStarting.value)
    return
  isStarting.value = true
  track('trial_plan_start_now_confirmed')
  try {
    const result = await startTrialPlanNow(startOrgId, props.plan.productId || undefined)
    track('trial_plan_started_now')
    if (props.orgId === startOrgId)
      toast.success(t('trial-plan-started-now', { plan: result.plan.planName }))
    emit('started', result.plan)
  }
  catch (error) {
    console.error('Cannot start trial plan now', error)
    const errorName = await getCapgoApiErrorName(error)
    // Only a confirmed decline means nothing was charged. A timeout or server error may
    // follow a successful charge, so never send the user to pay again: reload Billing instead.
    if (errorName === 'trial_plan_payment_failed') {
      track('trial_plan_start_now_failed')
      toast.error(t('trial-plan-start-now-error'))
      return
    }
    if (STALE_ERROR_CODES.has(errorName ?? '')) {
      track('trial_plan_start_now_unavailable')
      toast.error(t('trial-plan-start-now-unavailable'))
    }
    else {
      track('trial_plan_start_now_unconfirmed')
      toast.error(t('trial-plan-start-now-unconfirmed'))
    }
    emit('stale')
  }
  finally {
    isStarting.value = false
  }
}
</script>

<template>
  <BillingModal
    :title="t('trial-plan-start-now-title', { plan: plan.planName })"
    :busy="isStarting"
    @close="keepTrial"
  >
    <div class="flex items-start gap-3">
      <IconBolt class="mt-0.5 h-6 w-6 shrink-0 text-blue-500" aria-hidden="true" />
      <ul class="list-disc space-y-2 pl-4 text-sm leading-6 text-slate-700 dark:text-slate-200">
        <li class="font-medium">
          {{ t('trial-plan-start-now-charge', { plan: plan.planName, price, card: cardLabel }) }}
        </li>
        <li>{{ t('trial-plan-start-now-usage-reset') }}</li>
        <li>{{ t('trial-plan-start-now-trial-ends', { days: trialDaysLeft }, trialDaysLeft) }}</li>
      </ul>
    </div>
    <div class="mt-6 flex flex-wrap justify-end gap-2">
      <button type="button" class="d-btn d-btn-ghost" :disabled="isStarting" data-test="trial-plan-start-now-keep" @click="keepTrial">
        {{ t('trial-plan-start-now-keep-trial') }}
      </button>
      <button type="button" class="d-btn d-btn-primary" :disabled="isStarting" data-test="trial-plan-start-now-confirm" @click="startNow">
        <span v-if="isStarting" class="d-loading d-loading-spinner d-loading-sm" />
        {{ t('trial-plan-start-now-confirm') }}
      </button>
    </div>
  </BillingModal>
</template>
