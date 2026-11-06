<script setup lang="ts">
/**
 * Offered right after a trial org saves a card on its own (Billing, Credits): asks whether
 * the plan picked during onboarding should start automatically when the trial ends.
 * Lets the user switch Solo / Maker / Team first. Closes without showing anything when
 * there is no plan to offer (paying org, trial over, plan already scheduled).
 */

import type { TrialPlan, TrialPlanOption } from '~/services/stripe'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCalendar from '~icons/heroicons/calendar-days'
import BillingModal from '~/components/billing/BillingModal.vue'
import TrialPlanPicker from '~/components/billing/TrialPlanPicker.vue'
import { getLocalConfig } from '~/services/console'
import { formatLocalDate } from '~/services/date'
import { pushEvent } from '~/services/posthog'
import { formatStripeAmount, getTrialPlan, scheduleTrialPlan } from '~/services/stripe'

const props = defineProps<{
  orgId: string
  source: string
}>()

const emit = defineEmits<{
  close: []
  scheduled: [plan: TrialPlan]
}>()

const { t } = useI18n()
const config = getLocalConfig()
const plan = ref<TrialPlan | null>(null)
const plans = ref<TrialPlanOption[]>([])
const selectedProductId = ref('')
// The offer belongs to the org it was loaded for; an org change closes it.
const offerOrgId = props.orgId
const isScheduling = ref(false)

const selectedOption = computed(() => {
  return plans.value.find(option => option.productId === selectedProductId.value)
    ?? plans.value.find(option => option.planName === plan.value?.planName)
    ?? null
})
const selectedPlanName = computed(() => selectedOption.value?.planName ?? plan.value?.planName ?? '')
const price = computed(() => {
  if (selectedOption.value)
    return formatStripeAmount(selectedOption.value.amount, selectedOption.value.currency)
  return plan.value ? formatStripeAmount(plan.value.amount, plan.value.currency) : ''
})
const date = computed(() => plan.value ? formatLocalDate(plan.value.startsAt) : '')
const showPicker = computed(() => plans.value.length > 1)

function track(event: string) {
  pushEvent(event, config.apiHost, {
    org_id: offerOrgId,
    source: props.source,
    plan: selectedPlanName.value,
  })
}

watch(() => props.orgId, (id) => {
  if (id !== offerOrgId)
    emit('close')
})

onMounted(async () => {
  try {
    const result = await getTrialPlan(offerOrgId)
    if (props.orgId !== offerOrgId)
      return
    if (!result.plan || result.plan.scheduled || !result.card) {
      emit('close')
      return
    }
    plan.value = result.plan
    plans.value = result.plans ?? []
    selectedProductId.value = result.plan.productId
      || plans.value.find(option => option.planName === result.plan!.planName)?.productId
      || plans.value[0]?.productId
      || ''
    track('trial_plan_offer_shown')
  }
  catch (error) {
    console.error('Cannot load trial plan offer', error)
    emit('close')
  }
})

function decline() {
  if (isScheduling.value)
    return
  track('trial_plan_offer_declined')
  emit('close')
}

async function accept() {
  if (isScheduling.value)
    return
  isScheduling.value = true
  try {
    const result = await scheduleTrialPlan(offerOrgId, selectedProductId.value || undefined)
    track('trial_plan_offer_accepted')
    // The schedule is right for the original org; only skip the toast once the user moved on.
    if (props.orgId === offerOrgId)
      toast.success(t('trial-plan-scheduled', { plan: result.plan.planName, date: formatLocalDate(result.plan.startsAt) }))
    emit('scheduled', result.plan)
  }
  catch (error) {
    console.error('Cannot schedule trial plan', error)
    toast.error(t('trial-plan-schedule-error'))
    emit('close')
  }
  finally {
    isScheduling.value = false
  }
}
</script>

<template>
  <BillingModal
    v-if="plan"
    :title="t('trial-plan-offer-title', { plan: selectedPlanName })"
    :busy="isScheduling"
    @close="decline"
  >
    <div class="flex items-start gap-3">
      <IconCalendar class="mt-0.5 h-6 w-6 shrink-0 text-blue-500" aria-hidden="true" />
      <div class="space-y-2 text-sm leading-6 text-slate-700 dark:text-slate-200">
        <p class="font-medium">
          {{ t('trial-card-prompt-plan', { plan: selectedPlanName, price, date }) }}
        </p>
        <p class="text-slate-600 dark:text-slate-300">
          {{ t('trial-plan-offer-no-charge') }}
        </p>
      </div>
    </div>
    <TrialPlanPicker
      v-if="showPicker"
      v-model="selectedProductId"
      :options="plans"
      :disabled="isScheduling"
    />
    <div class="mt-6 flex flex-wrap justify-end gap-2">
      <button type="button" class="d-btn d-btn-ghost" :disabled="isScheduling" data-test="trial-plan-offer-decline" @click="decline">
        {{ t('trial-plan-offer-decline') }}
      </button>
      <button type="button" class="d-btn d-btn-primary" :disabled="isScheduling" data-test="trial-plan-offer-accept" @click="accept">
        <span v-if="isScheduling" class="d-loading d-loading-spinner d-loading-sm" />
        {{ t('trial-plan-start', { plan: selectedPlanName }) }}
      </button>
    </div>
  </BillingModal>
</template>
