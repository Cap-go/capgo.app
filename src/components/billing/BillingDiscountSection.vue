<script setup lang="ts">
import type { BillingDiscount, BillingDiscounts } from '~/services/stripe'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getCapgoApiErrorCode } from '~/services/capgoApi'
import { formatLocalDate } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { applyBillingPromotionCode, formatStripeAmount, getBillingDiscounts } from '~/services/stripe'

const props = defineProps<{ orgId: string }>()
const emit = defineEmits<{ denied: [] }>()
const { t } = useI18n()
const state = ref<BillingDiscounts | null>(null)
const loading = ref(true)
const failed = ref(false)
const code = ref('')
const replaceExisting = ref(false)
const busy = ref(false)
const error = ref('')
const success = ref(false)
let redemptionId = crypto.randomUUID()
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})
watch(code, () => {
  replaceExisting.value = false
})
watch([code, replaceExisting], () => {
  redemptionId = crypto.randomUUID()
  success.value = false
  error.value = ''
})

function discountLabel(discount: BillingDiscount) {
  if (discount.percentOff !== null)
    return t('billing-discount-percent', { amount: discount.percentOff })
  if (discount.amountOff !== null && discount.currency)
    return t('billing-discount-amount', { amount: formatStripeAmount(discount.amountOff, discount.currency) })
  return discount.name || t('billing-discount-active')
}

async function load() {
  loading.value = true
  failed.value = false
  try {
    const data = await getBillingDiscounts(props.orgId)
    if (!disposed)
      state.value = data
  }
  catch {
    if (!disposed)
      failed.value = true
  }
  finally {
    if (!disposed)
      loading.value = false
  }
}
onMounted(load)

async function apply() {
  if (busy.value || !code.value.trim())
    return
  busy.value = true
  error.value = ''
  success.value = false
  try {
    const allowed = await checkPermissions('org.update_billing', { orgId: props.orgId })
    if (disposed)
      return
    if (!allowed) {
      emit('denied')
      return
    }
    const result = await applyBillingPromotionCode(props.orgId, code.value.trim(), replaceExisting.value, redemptionId)
    if (!disposed && state.value) {
      state.value.discounts = result.discounts
      success.value = result.discounts.some(discount => discount.code?.toLowerCase() === code.value.trim().toLowerCase())
      if (!success.value) {
        replaceExisting.value = false
        redemptionId = crypto.randomUUID()
        await nextTick()
        if (!disposed)
          error.value = t('billing-promo-changed')
      }
    }
  }
  catch (cause) {
    const errorCode = await getCapgoApiErrorCode(cause)
    if (disposed)
      return
    let errorKey = 'billing-promo-error'
    if (errorCode === 'promotion_replace_required')
      errorKey = 'billing-promo-replace-required'
    else if (errorCode === 'promotion_checkout_only')
      errorKey = 'billing-promo-checkout-only'
    error.value = t(errorKey)
    // Refresh after failures: another admin may have added a discount since this page loaded.
    await load()
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="billing-discounts">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {{ t('billing-discounts-heading') }}
    </h2>
    <output v-if="loading" class="mt-4 block" :aria-label="t('loading')">
      <span class="d-loading d-loading-spinner d-loading-sm" />
    </output>
    <div v-else-if="failed" class="mt-4" role="alert">
      <p class="text-sm text-red-600 dark:text-red-300">
        {{ t('billing-discounts-load-error') }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-outline mt-2" @click="load">
        {{ t('retry') }}
      </button>
    </div>
    <template v-else-if="state">
      <ul v-if="state.discounts.length" class="mt-3 space-y-2 text-sm text-slate-700 dark:text-slate-200">
        <li v-for="(discount, index) in state.discounts" :key="index">
          <span class="font-semibold">{{ discountLabel(discount) }}</span>
          <span v-if="discount.code"> · {{ discount.code }}</span>
          <span v-else-if="discount.name && discount.name !== discountLabel(discount)"> · {{ discount.name }}</span>
          <p v-if="discount.endsAt" class="mt-1 text-xs">
            {{ t('billing-discount-ends', { date: formatLocalDate(discount.endsAt) }) }}
          </p>
        </li>
      </ul>
      <p v-else class="mt-3 text-sm text-slate-600 dark:text-slate-300">
        {{ t('billing-no-discount') }}
      </p>
      <template v-if="!state.hasSubscription">
        <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {{ t('billing-promo-checkout') }}
        </p>
        <router-link to="/settings/organization/plans" class="d-btn d-btn-sm d-btn-outline mt-3">
          {{ t('billing-choose-plan') }}
        </router-link>
      </template>
      <form v-else-if="state.canApply" class="mt-4 space-y-3" data-test="billing-promo-form" @submit.prevent="apply">
        <p class="text-sm text-slate-600 dark:text-slate-300">
          {{ t('billing-promo-desc') }}
        </p>
        <div class="flex flex-col items-start gap-2 sm:flex-row sm:items-end">
          <label class="flex w-full flex-col gap-1 text-sm sm:max-w-xs">
            {{ t('billing-promo-code') }}
            <input v-model="code" name="promotionCode" autocomplete="off" maxlength="100" required :disabled="busy" class="d-input d-input-bordered w-full">
          </label>
          <button type="submit" class="d-btn d-btn-primary" :disabled="busy || !code.trim() || (state.discounts.length > 0 && !replaceExisting)">
            <span v-if="busy" class="d-loading d-loading-spinner d-loading-xs" />
            {{ t('billing-promo-apply') }}
          </button>
        </div>
        <label v-if="state.discounts.length" class="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input v-model="replaceExisting" type="checkbox" :disabled="busy" class="d-checkbox d-checkbox-sm shrink-0">
          {{ t('billing-promo-replace-confirm') }}
        </label>
      </form>
      <p v-else class="mt-2 text-sm text-slate-600 dark:text-slate-300">
        {{ t('billing-promo-unavailable') }}
      </p>
    </template>
    <p v-if="error" role="alert" class="mt-3 text-sm text-red-600 dark:text-red-300">
      {{ error }}
    </p>
    <output v-if="success" class="mt-3 block text-sm text-emerald-700 dark:text-emerald-300">
      {{ t('billing-promo-success') }}
    </output>
  </section>
</template>
