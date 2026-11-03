<script setup lang="ts">
import type { BillingProfile, BillingProfileTaxIdType, BillingProfileUpdate } from '~/services/stripe'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import FormField from '~/components/forms/FormField.vue'
import { BILLING_PROFILE_TAX_ID_TYPES, getBillingProfile, saveBillingProfile } from '~/services/stripe'
import { rules, validateField } from '~/utils/formValidation'

const props = defineProps<{ orgId: string }>()

const { t } = useI18n()

const isLoading = ref(true)
const loadFailed = ref(false)
const isSaving = ref(false)
const submitted = ref(false)

const line1 = ref('')
const line2 = ref('')
const city = ref('')
const state = ref('')
const postalCode = ref('')
const country = ref('')
const taxIdType = ref<BillingProfileTaxIdType>('eu_vat')
const taxIdValue = ref('')
const hadTaxIdOnLoad = ref(false)

const taxIdTypeOptions = computed(() => BILLING_PROFILE_TAX_ID_TYPES.map(type => ({
  value: type,
  label: t(`billing-profile-tax-type-${type}`),
})))

const line1Errors = computed(() => validateField(line1.value, [rules.required(t('billing-profile-line1'))]))
const countryErrors = computed(() => validateField(country.value.trim(), [
  rules.required(t('billing-profile-country')),
  rules.matches(/^[a-z]{2}$/i, t('billing-profile-country-format')),
]))

let loadRun = 0

function applyProfile(profile: BillingProfile) {
  hadTaxIdOnLoad.value = profile.taxId !== null
  line1.value = profile.address.line1 ?? ''
  line2.value = profile.address.line2 ?? ''
  city.value = profile.address.city ?? ''
  state.value = profile.address.state ?? ''
  postalCode.value = profile.address.postalCode ?? ''
  country.value = profile.address.country ?? ''
  if (profile.taxId) {
    taxIdType.value = (BILLING_PROFILE_TAX_ID_TYPES as readonly string[]).includes(profile.taxId.type)
      ? profile.taxId.type as BillingProfileTaxIdType
      : 'eu_vat'
    taxIdValue.value = profile.taxId.value
  }
  else {
    taxIdType.value = 'eu_vat'
    taxIdValue.value = ''
  }
}

async function loadProfile() {
  const run = ++loadRun
  if (!props.orgId)
    return
  isLoading.value = true
  loadFailed.value = false
  try {
    const profile = await getBillingProfile(props.orgId)
    if (run === loadRun)
      applyProfile(profile)
  }
  catch (error) {
    console.error('Cannot load billing profile', error)
    if (run === loadRun)
      loadFailed.value = true
  }
  finally {
    if (run === loadRun)
      isLoading.value = false
  }
}

function buildUpdate(): BillingProfileUpdate {
  const normalizedCountry = country.value.trim().toUpperCase()
  const trimmedTaxId = taxIdValue.value.trim()
  const update: BillingProfileUpdate = {
    address: {
      line1: line1.value.trim(),
      line2: line2.value.trim() || null,
      city: city.value.trim() || null,
      state: state.value.trim() || null,
      postalCode: postalCode.value.trim() || null,
      country: normalizedCountry,
    },
  }
  if (trimmedTaxId)
    update.taxId = { type: taxIdType.value, value: trimmedTaxId }
  else if (hadTaxIdOnLoad.value)
    update.taxId = null
  return update
}

async function saveProfile() {
  submitted.value = true
  if (line1Errors.value.length || countryErrors.value.length)
    return
  if (!props.orgId || isSaving.value)
    return
  isSaving.value = true
  try {
    const profile = await saveBillingProfile(props.orgId, buildUpdate())
    applyProfile(profile)
    toast.success(t('billing-profile-saved'))
    submitted.value = false
  }
  catch (error) {
    console.error('Cannot save billing profile', error)
    toast.error(t('billing-profile-save-error'))
    void loadProfile()
  }
  finally {
    isSaving.value = false
  }
}

watch(() => props.orgId, () => {
  submitted.value = false
  void loadProfile()
}, { immediate: true })
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="billing-profile">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {{ t('billing-profile-heading') }}
    </h2>
    <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
      {{ t('billing-profile-desc') }}
    </p>

    <div v-if="isLoading" class="flex justify-center py-8">
      <span class="d-loading d-loading-spinner d-loading-md text-blue-500" />
    </div>

    <div v-else-if="loadFailed" class="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200" data-test="billing-profile-load-error">
      <p>{{ t('billing-profile-load-error') }}</p>
      <button type="button" class="d-btn d-btn-sm d-btn-outline mt-3" @click="loadProfile">
        {{ t('retry') }}
      </button>
    </div>

    <form v-else class="mt-4 space-y-1" @submit.prevent="saveProfile">
      <FormField
        id="billing-profile-line1"
        v-model="line1"
        :label="t('billing-profile-line1')"
        :errors="line1Errors"
        :submitted="submitted"
        validation-visibility="live"
        data-test="billing-profile-line1"
      />
      <FormField
        id="billing-profile-line2"
        v-model="line2"
        :label="t('billing-profile-line2')"
        data-test="billing-profile-line2"
      />
      <div class="grid gap-0 md:grid-cols-2 md:gap-x-4">
        <FormField
          id="billing-profile-city"
          v-model="city"
          :label="t('billing-profile-city')"
          data-test="billing-profile-city"
        />
        <FormField
          id="billing-profile-state"
          v-model="state"
          :label="t('billing-profile-state')"
          data-test="billing-profile-state"
        />
      </div>
      <div class="grid gap-0 md:grid-cols-2 md:gap-x-4">
        <FormField
          id="billing-profile-postal-code"
          v-model="postalCode"
          :label="t('billing-profile-postal-code')"
          data-test="billing-profile-postal-code"
        />
        <FormField
          id="billing-profile-country"
          v-model="country"
          :label="t('billing-profile-country')"
          :help="t('billing-profile-country-help')"
          :errors="countryErrors"
          :submitted="submitted"
          validation-visibility="live"
          data-test="billing-profile-country"
        />
      </div>

      <div class="border-t border-slate-100 pt-4 dark:border-white/10">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {{ t('billing-profile-tax-heading') }}
        </h3>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ t('billing-profile-tax-desc') }}
        </p>
        <div class="mt-3 grid gap-0 md:grid-cols-2 md:gap-x-4">
          <label for="billing-profile-tax-type" class="mb-4 block text-base">
            <span class="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('billing-profile-tax-type') }}</span>
            <select
              id="billing-profile-tax-type"
              v-model="taxIdType"
              class="d-select d-select-bordered w-full bg-white dark:bg-slate-900"
              data-test="billing-profile-tax-type"
            >
              <option v-for="option in taxIdTypeOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <FormField
            id="billing-profile-tax-value"
            v-model="taxIdValue"
            :label="t('billing-profile-tax-value')"
            :help="t('billing-profile-tax-value-help')"
            data-test="billing-profile-tax-value"
          />
        </div>
      </div>

      <button type="submit" class="d-btn d-btn-sm d-btn-primary mt-2" :disabled="isSaving" data-test="billing-profile-save">
        <span v-if="isSaving" class="d-loading d-loading-spinner d-loading-xs" />
        {{ t('billing-profile-save') }}
      </button>
    </form>
  </section>
</template>
