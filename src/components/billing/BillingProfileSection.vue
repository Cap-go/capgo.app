<script setup lang="ts">
import type { BillingDetails, BillingProfile } from '../../../supabase/functions/shared/billing-profile'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BillingModal from '~/components/billing/BillingModal.vue'
import { checkPermissions } from '~/services/permissions'
import { addBillingTaxId, getBillingProfile, removeBillingTaxId, updateBillingDetails } from '~/services/stripe'
import { BILLING_COUNTRIES, BILLING_TAX_ID_TYPES } from '../../../supabase/functions/shared/billing-profile'

const props = defineProps<{ orgId: string }>()
const emit = defineEmits<{ denied: [], detailsSaved: [] }>()
const { t, locale } = useI18n()
const profile = ref<BillingProfile | null>(null)
const loading = ref(true)
const loadFailed = ref(false)
const editing = ref<'details' | 'tax' | null>(null)
const draft = ref<BillingDetails | null>(null)
const busy = ref(false)
const error = ref('')
const taxType = ref<string>('eu_vat')
const taxValue = ref('')
const removing = ref<string | null>(null)
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

const regionNames = computed(() => new Intl.DisplayNames([locale.value], { type: 'region' }))
const countries = computed(() => BILLING_COUNTRIES.map(code => ({ code, name: regionNames.value.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name)))
function taxLabel(type: string) {
  const [region, ...kind] = type.split('_')
  if (!/^[a-z]{2}$/.test(region))
    return type.toUpperCase()
  return `${regionNames.value.of(region.toUpperCase()) ?? region.toUpperCase()} · ${kind.join(' ').toUpperCase()}`
}
const taxTypes = computed(() => BILLING_TAX_ID_TYPES.map(type => ({ type, label: taxLabel(type) })).sort((a, b) => a.label.localeCompare(b.label)))
const addressLines = computed(() => {
  const address = profile.value?.address
  if (!address)
    return []
  return [address.line1, address.line2, [address.city, address.state, address.postal_code].filter(Boolean).join(', '), address.country ? regionNames.value.of(address.country) : ''].filter(Boolean)
})

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const result = await getBillingProfile(props.orgId)
    if (!disposed)
      profile.value = result
  }
  catch {
    if (!disposed)
      loadFailed.value = true
  }
  finally {
    if (!disposed)
      loading.value = false
  }
}
onMounted(load)

async function edit(mode: 'details' | 'tax') {
  const allowed = await checkPermissions('org.update_billing', { orgId: props.orgId })
  if (disposed)
    return
  if (!allowed) {
    emit('denied')
    return
  }
  if (!profile.value)
    return
  const { name, email, phone, address } = profile.value
  draft.value = { name, email, phone, address: { ...address } }
  error.value = ''
  removing.value = null
  editing.value = mode
}

async function saveDetails() {
  if (!draft.value || busy.value)
    return
  busy.value = true
  error.value = ''
  try {
    const details = await updateBillingDetails(props.orgId, draft.value)
    if (!disposed && profile.value) {
      profile.value = { ...profile.value, ...details }
      editing.value = null
      emit('detailsSaved')
    }
  }
  catch {
    if (!disposed)
      error.value = t('billing-details-save-error')
  }
  finally {
    busy.value = false
  }
}

async function addTax() {
  if (busy.value || !taxValue.value.trim())
    return
  busy.value = true
  error.value = ''
  try {
    const taxId = await addBillingTaxId(props.orgId, { type: taxType.value, value: taxValue.value.trim() })
    if (!disposed && profile.value) {
      profile.value.taxIds = [...profile.value.taxIds.filter(item => item.id !== taxId.id), taxId]
      taxValue.value = ''
    }
  }
  catch {
    if (!disposed)
      error.value = t('billing-tax-add-error')
  }
  finally {
    busy.value = false
  }
}

async function removeTax(id: string) {
  if (busy.value)
    return
  busy.value = true
  error.value = ''
  try {
    await removeBillingTaxId(props.orgId, id)
    if (!disposed && profile.value) {
      profile.value.taxIds = profile.value.taxIds.filter(item => item.id !== id)
      removing.value = null
    }
  }
  catch {
    if (!disposed)
      error.value = t('billing-tax-remove-error')
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="billing-profile">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {{ t('billing-details-heading') }}
    </h2>
    <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
      {{ t('billing-details-desc') }}
    </p>
    <output v-if="loading" class="block py-5" :aria-label="t('loading')">
      <span class="d-loading d-loading-spinner d-loading-sm" />
    </output>
    <div v-else-if="loadFailed" class="mt-4" role="alert">
      <p class="text-sm text-red-600 dark:text-red-300">
        {{ t('billing-details-load-error') }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-outline mt-2" @click="load">
        {{ t('retry') }}
      </button>
    </div>
    <div v-else-if="profile" class="mt-5 grid gap-6 sm:grid-cols-2">
      <div>
        <h3 class="text-sm font-medium text-slate-900 dark:text-white">
          {{ t('billing-invoice-details') }}
        </h3>
        <div class="mt-2 break-words text-sm leading-6 text-slate-600 dark:text-slate-300" data-test="billing-profile-details">
          <p class="font-medium text-slate-900 dark:text-white">
            {{ profile.name || t('billing-not-provided') }}
          </p>
          <p>{{ profile.email || t('billing-no-email') }}</p>
          <p v-if="profile.phone">
            {{ profile.phone }}
          </p>
          <p v-for="(line, index) in addressLines" :key="index">
            {{ line }}
          </p>
          <p v-if="!addressLines.length">
            {{ t('billing-no-address') }}
          </p>
        </div>
        <button type="button" class="d-btn d-btn-sm d-btn-outline mt-4" data-test="billing-edit-details" @click="edit('details')">
          {{ t('billing-edit-details') }}
        </button>
      </div>
      <div>
        <h3 class="text-sm font-medium text-slate-900 dark:text-white">
          {{ t('billing-tax-heading') }}
        </h3>
        <ul v-if="profile.taxIds.length" class="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <li v-for="taxId in profile.taxIds" :key="taxId.id" class="break-words">
            <p>{{ taxLabel(taxId.type) }} · {{ taxId.value }}</p>
            <p class="text-xs">
              {{ t(`billing-tax-status-${taxId.status}`) }}
            </p>
          </li>
        </ul>
        <p v-else class="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {{ t('billing-no-tax-id') }}
        </p>
        <button type="button" class="d-btn d-btn-sm d-btn-outline mt-4" data-test="billing-manage-tax" @click="edit('tax')">
          {{ t('billing-manage-tax') }}
        </button>
      </div>
    </div>
    <BillingModal v-if="editing === 'details' && draft" :title="t('billing-edit-details')" :description="t('billing-details-desc')" :busy="busy" size="lg" @close="editing = null">
      <form class="grid gap-4 sm:grid-cols-2" data-test="billing-details-form" @submit.prevent="saveDetails">
        <label v-for="field in (['name', 'email', 'phone'] as const)" :key="field" class="flex flex-col gap-1 text-sm" :class="field === 'name' ? 'sm:col-span-2' : ''">
          {{ t(`billing-field-${field}`) }}
          <input v-model="draft[field]" :name="field" :type="field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'" :required="field !== 'phone'" :maxlength="field === 'email' ? 320 : field === 'phone' ? 20 : 200" class="d-input d-input-bordered w-full" :autocomplete="field === 'name' ? 'billing organization' : field === 'phone' ? 'billing tel' : 'billing email'">
        </label>
        <label v-for="field in (['line1', 'line2', 'city', 'state', 'postal_code'] as const)" :key="field" class="flex flex-col gap-1 text-sm" :class="field === 'line1' || field === 'line2' ? 'sm:col-span-2' : ''">
          {{ t(`billing-field-${field}`) }}
          <input v-model="draft.address[field]" :name="field" :required="field === 'line1'" :maxlength="field === 'postal_code' ? 20 : 200" class="d-input d-input-bordered w-full">
        </label>
        <label class="flex flex-col gap-1 text-sm">
          {{ t('billing-field-country') }}
          <select v-model="draft.address.country" name="country" required class="d-select d-select-bordered w-full">
            <option disabled value="">{{ t('billing-select-country') }}</option>
            <option v-for="country in countries" :key="country.code" :value="country.code">{{ country.name }}</option>
          </select>
        </label>
        <p v-if="error" role="alert" class="text-sm text-red-600 sm:col-span-2 dark:text-red-300">
          {{ error }}
        </p>
        <div class="flex justify-end gap-2 sm:col-span-2">
          <button type="button" class="d-btn d-btn-ghost" :disabled="busy" @click="editing = null">
            {{ t('button-cancel') }}
          </button>
          <button type="submit" class="d-btn d-btn-primary" :disabled="busy" data-test="billing-save-details">
            <span v-if="busy" class="d-loading d-loading-spinner d-loading-xs" />
            {{ t('billing-save-details') }}
          </button>
        </div>
      </form>
    </BillingModal>
    <BillingModal v-if="editing === 'tax' && profile" :title="t('billing-tax-heading')" :description="t('billing-tax-desc')" :busy="busy" @close="editing = null">
      <ul class="space-y-4">
        <li v-for="taxId in profile.taxIds" :key="taxId.id" class="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p class="break-words text-sm font-medium">
            {{ taxLabel(taxId.type) }} · {{ taxId.value }}
          </p>
          <p class="mt-1 text-xs">
            {{ t(`billing-tax-status-${taxId.status}`) }}
          </p>
          <template v-if="removing === taxId.id">
            <p class="mt-2 text-sm">
              {{ t('billing-tax-remove-confirm') }}
            </p>
            <button type="button" class="d-btn d-btn-sm d-btn-error mt-2" :disabled="busy" @click="removeTax(taxId.id)">
              {{ t('billing-tax-remove') }}
            </button>
            <button type="button" class="d-btn d-btn-sm d-btn-ghost mt-2" :disabled="busy" @click="removing = null">
              {{ t('button-cancel') }}
            </button>
          </template>
          <button v-else type="button" class="d-btn d-btn-sm d-btn-ghost mt-2" :disabled="busy" @click="removing = taxId.id">
            {{ t('billing-tax-remove') }}
          </button>
        </li>
      </ul>
      <form class="mt-5 space-y-4" data-test="billing-tax-form" @submit.prevent="addTax">
        <label class="flex flex-col gap-1 text-sm">
          {{ t('billing-tax-type') }}
          <select v-model="taxType" name="taxType" class="d-select d-select-bordered w-full" :disabled="busy">
            <option v-for="option in taxTypes" :key="option.type" :value="option.type">{{ option.label }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          {{ t('billing-tax-value') }}
          <input v-model="taxValue" name="taxValue" required maxlength="100" class="d-input d-input-bordered w-full" :disabled="busy">
        </label>
        <p v-if="error" role="alert" class="text-sm text-red-600 dark:text-red-300">
          {{ error }}
        </p>
        <div class="flex justify-end gap-2">
          <button type="button" class="d-btn d-btn-ghost" :disabled="busy" @click="editing = null">
            {{ t('billing-done') }}
          </button>
          <button type="submit" class="d-btn d-btn-primary" :disabled="busy || !taxValue.trim()">
            <span v-if="busy" class="d-loading d-loading-spinner d-loading-xs" />
            {{ t('billing-tax-add') }}
          </button>
        </div>
      </form>
    </BillingModal>
  </section>
</template>
