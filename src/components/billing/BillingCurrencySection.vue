<script setup lang="ts">
import type { BillingCurrencyPreview, BillingCurrencyState } from '../../../supabase/functions/shared/billing-profile'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { checkPermissions } from '~/services/permissions'
import { billingCurrencyErrorMessage, changeBillingCurrency, formatStripeAmount, getBillingCurrencyState, previewBillingCurrency } from '~/services/stripe'
import BillingModal from './BillingModal.vue'

const props = defineProps<{ orgId: string }>()
const emit = defineEmits<{ denied: [], changed: [] }>()
const { t, locale } = useI18n()
const state = ref<BillingCurrencyState | null>(null)
const editing = ref(false)
const selected = ref('')
const confirmed = ref(false)
const preview = ref<BillingCurrencyPreview | null>(null)
const previewBusy = ref(false)
let previewRun = 0
const busy = ref(false)
const failed = ref(false)
const error = ref('')
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})
function date(value: string | null) {
  return value ? new Date(value).toLocaleDateString(locale.value) : ''
}
function label(currency: string) {
  const code = currency.toUpperCase()
  return `${code} — ${new Intl.DisplayNames([locale.value], { type: 'currency' }).of(code)}`
}
async function load() {
  failed.value = false
  try {
    const result = await getBillingCurrencyState(props.orgId)
    if (!disposed)
      state.value = result
  }
  catch { failed.value = true }
}
onMounted(load)
async function edit() {
  const allowed = await checkPermissions('org.update_billing', { orgId: props.orgId })
  if (disposed)
    return
  if (!allowed) {
    emit('denied')
    return
  }
  await load()
  if (disposed || failed.value || !state.value)
    return
  selected.value = state.value.pendingCurrency ?? state.value.currency ?? state.value.currencies[0] ?? ''
  confirmed.value = false
  error.value = ''
  editing.value = true
}
async function loadPreview() {
  const run = ++previewRun
  preview.value = null
  confirmed.value = false
  previewBusy.value = false
  if (!editing.value || !state.value?.subscriptionId || selected.value === state.value.currency)
    return
  previewBusy.value = true
  error.value = ''
  try {
    const result = await previewBillingCurrency(props.orgId, selected.value)
    if (!disposed && run === previewRun)
      preview.value = result
  }
  catch (cause) {
    const message = await billingCurrencyErrorMessage(cause, 'billing-currency-preview-error')
    if (!disposed && run === previewRun)
      error.value = message
  }
  finally {
    if (run === previewRun)
      previewBusy.value = false
  }
}
watch([selected, editing], loadPreview)

async function save() {
  if (busy.value || !state.value || (state.value.subscriptionId && (!confirmed.value || !preview.value)))
    return
  busy.value = true
  error.value = ''
  try {
    const result = await changeBillingCurrency(props.orgId, selected.value, state.value.subscriptionId, preview.value?.quoteId)
    if (!disposed) {
      state.value = result
      editing.value = false
      emit('changed')
    }
  }
  catch (cause) { error.value = await billingCurrencyErrorMessage(cause, 'billing-currency-save-error') }
  finally { busy.value = false }
}
</script>

<template>
  <div class="mt-6 border-t border-slate-200 pt-4 dark:border-slate-700" data-test="billing-currency">
    <h3 class="text-sm font-medium text-slate-900 dark:text-white">
      {{ t('billing-currency-heading') }}
    </h3>
    <div v-if="failed" role="alert" class="mt-2">
      <p>{{ t('billing-currency-load-error') }}</p>
      <button class="d-btn d-btn-sm mt-2" @click="load">
        {{ t('retry') }}
      </button>
    </div>
    <template v-else-if="state">
      <p class="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
        {{ state.currency?.toUpperCase() || t('billing-currency-unset') }}
      </p>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
        {{ t('billing-currency-description') }}
      </p>
      <p v-if="state.pendingCurrency" class="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-100" data-test="billing-currency-pending">
        {{ t('billing-currency-pending', { currency: state.pendingCurrency.toUpperCase(), date: date(state.endsAt), resume: t('billing-resume') }) }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-outline mt-3" data-test="billing-change-currency" @click="edit">
        {{ t('billing-change-currency') }}
      </button>
      <RouterLink v-if="!state.subscriptionId" class="d-btn d-btn-sm d-btn-primary ml-2 mt-3" to="/settings/organization/plans">
        {{ t('billing-currency-choose-plan') }}
      </RouterLink>
    </template>
    <span v-else class="d-loading d-loading-spinner d-loading-sm mt-2" />
    <BillingModal v-if="editing && state" :title="t('billing-change-currency')" :busy="busy" @close="editing = false">
      <form class="space-y-4" data-test="billing-currency-form" @submit.prevent="save">
        <label class="flex flex-col gap-1 text-sm">
          {{ t('billing-currency-heading') }}
          <select v-model="selected" class="d-select d-select-bordered w-full" :disabled="busy" @change="confirmed = false">
            <option v-for="currency in state.currencies" :key="currency" :value="currency">{{ label(currency) }}</option>
          </select>
        </label>
        <p class="text-sm">
          {{ t('billing-currency-price-review') }}
        </p>
        <p v-if="state.regionalDiscountEligible" class="text-sm" data-test="billing-currency-regional-note">
          {{ t('billing-currency-regional-requirement') }}
        </p>
        <template v-if="state.subscriptionId">
          <p v-if="previewBusy" role="status" class="text-sm">
            {{ t('loading') }}
          </p>
          <p v-else-if="preview" class="text-base font-semibold" data-test="billing-currency-renewal">
            {{ t('billing-currency-renewal-estimate', { amount: formatStripeAmount(preview.amount, preview.currency), interval: t(preview.interval === 'year' ? 'billing-currency-year' : 'billing-currency-month') }) }}
          </p>
          <p class="rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
            {{ t('billing-currency-transition', { date: date(state.endsAt), currency: selected.toUpperCase() }) }}
          </p>
          <label class="flex items-start gap-3 text-sm">
            <input v-model="confirmed" type="checkbox" class="d-checkbox d-checkbox-sm" :disabled="busy || previewBusy || !preview">
            {{ t('billing-currency-confirm-cancel') }}
          </label>
        </template>
        <p v-else class="text-sm">
          {{ t('billing-currency-immediate') }}
        </p>
        <p v-if="error" role="alert" class="text-sm text-red-600 dark:text-red-300">
          {{ error }}
        </p>
        <button v-if="state.subscriptionId && selected !== state.currency && !preview && !previewBusy" type="button" class="d-btn d-btn-sm" @click="loadPreview">
          {{ t('retry') }}
        </button>
        <div class="flex justify-end gap-2">
          <button type="button" class="d-btn d-btn-ghost" :disabled="busy" @click="editing = false">
            {{ t('button-cancel') }}
          </button>
          <button type="submit" class="d-btn d-btn-primary" :disabled="busy || !selected || selected === state.currency || (!!state.subscriptionId && (!confirmed || !preview || previewBusy))">
            {{ t(state.subscriptionId ? 'billing-currency-schedule' : 'billing-currency-save') }}
          </button>
        </div>
      </form>
    </BillingModal>
  </div>
</template>
