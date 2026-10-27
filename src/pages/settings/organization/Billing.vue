<script setup lang="ts">
import type { BillingCard, BillingInvoice, BillingOverview, BillingSubscription } from '~/services/stripe'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconDownload from '~icons/heroicons/arrow-down-tray'
import IconCard from '~icons/heroicons/credit-card'
import IconExclamationTriangle from '~icons/heroicons/exclamation-triangle'
import IconShieldCheck from '~icons/heroicons/shield-check'
import CancelPlanModal from '~/components/billing/CancelPlanModal.vue'
import CardFormModal from '~/components/billing/CardFormModal.vue'
import TrialPlanOfferModal from '~/components/billing/TrialPlanOfferModal.vue'
import TrialPlanStartNowModal from '~/components/billing/TrialPlanStartNowModal.vue'
import RbacPermissionOnlyModal from '~/components/RbacPermissionOnlyModal.vue'
import { formatLocalDate } from '~/services/date'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { cancelTrialPlan, formatStripeAmount, getBillingOverview, payOpenInvoice, removeBackupCard, resumeSubscription, scheduleTrialPlan } from '~/services/stripe'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)
displayStore.NavTitle = t('billing-portal-tab')

const overview = ref<BillingOverview | null>(null)
const isLoading = ref(true)
const loadFailed = ref(false)
const isPaying = ref(false)
const isResuming = ref(false)
const isRemovingBackup = ref(false)
const isUpdatingTrialPlan = ref(false)
// Org the post-card trial plan offer is for (pinned in case the user switches org).
const trialPlanOfferOrgId = ref<string | null>(null)
const showStartNowModal = ref(false)
// Start the trial plan once the card form saves a card.
let scheduleAfterCardSave = false
const showCardModal = ref<'setup' | 'backup' | 'invoice' | null>(null)
const showCancelModal = ref(false)
const permissionModal = ref<'org.read_billing' | 'org.update_billing' | null>(null)
let loadRun = 0

const orgId = computed(() => currentOrganization.value?.gid ?? '')
const card = computed(() => overview.value?.card ?? null)
const backupCard = computed(() => overview.value?.backupCard ?? null)
// No publishable key: Stripe.js forms are unavailable, server-side actions still work.
const canEnterCard = computed(() => !!overview.value?.publishableKey)
const subscription = computed(() => overview.value?.subscription ?? null)
const openInvoice = computed(() => overview.value?.openInvoice ?? null)
const invoices = computed(() => overview.value?.invoices ?? [])
// A scheduled plan always shows (Stripe will charge it); the offer only without a subscription.
const trialPlan = computed(() => {
  const plan = overview.value?.trialPlan ?? null
  return plan && (plan.scheduled || !subscription.value) ? plan : null
})
const trialPlanPrice = computed(() => trialPlan.value ? formatStripeAmount(trialPlan.value.amount, trialPlan.value.currency) : '')
const trialPlanDate = computed(() => trialPlan.value ? formatLocalDate(trialPlan.value.startsAt) : '')
// Start now charges the saved card immediately, so it needs a card and no subscription yet.
const canStartTrialPlanNow = computed(() => !!trialPlan.value && !!card.value && !subscription.value)
const trialDaysLeft = computed(() => currentOrganization.value?.trial_left ?? 0)
const openInvoiceAmount = computed(() => openInvoice.value ? formatStripeAmount(openInvoice.value.amountDue, openInvoice.value.currency) : '')

const subscriptionLine = computed(() => {
  const sub = subscription.value
  if (!sub)
    return t('billing-no-subscription')
  const endDate = formatLocalDate(sub.cancelAt ?? sub.currentPeriodEnd)
  if (sub.cancelAtPeriodEnd || sub.cancelAt)
    return t('billing-subscription-ends', { date: endDate })
  if (sub.status === 'past_due' || sub.status === 'unpaid')
    return t('billing-subscription-past-due')
  return endDate ? t('billing-subscription-renews', { date: endDate }) : t('billing-subscription-active')
})

function brandLabel(value: BillingCard) {
  return value.brand.charAt(0).toUpperCase() + value.brand.slice(1)
}

function invoiceStatusClass(status: BillingInvoice['status']) {
  if (status === 'paid')
    return 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300'
  if (status === 'open')
    return 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-200'
  return 'bg-slate-50 text-slate-600 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-300'
}

async function loadOverview() {
  const run = ++loadRun
  const id = orgId.value
  overview.value = null
  loadFailed.value = false
  if (!id)
    return
  isLoading.value = true
  if (!await checkPermissions('org.read_billing', { orgId: id })) {
    if (run === loadRun) {
      permissionModal.value = 'org.read_billing'
      isLoading.value = false
    }
    return
  }
  try {
    const data = await getBillingOverview(id)
    if (run === loadRun)
      overview.value = data
  }
  catch (error) {
    console.error('Cannot load billing overview', error)
    if (run === loadRun)
      loadFailed.value = true
  }
  finally {
    if (run === loadRun)
      isLoading.value = false
  }
}

async function requireUpdateBilling() {
  if (orgId.value && await checkPermissions('org.update_billing', { orgId: orgId.value }))
    return true
  permissionModal.value = 'org.update_billing'
  return false
}

async function openCardForm(mode: 'setup' | 'backup' = 'setup') {
  if (await requireUpdateBilling())
    showCardModal.value = mode
}

async function removeBackup() {
  const backup = backupCard.value
  // Scope the request to the org that rendered this card.
  const id = orgId.value
  if (!backup || !id || isRemovingBackup.value)
    return
  // Lock before the async permission check so double clicks send one request.
  isRemovingBackup.value = true
  try {
    if (!await requireUpdateBilling())
      return
    const cards = await removeBackupCard(id, backup.id)
    if (orgId.value !== id)
      return
    if (overview.value)
      overview.value = { ...overview.value, ...cards }
    toast.success(t('billing-backup-card-removed'))
  }
  catch (error) {
    console.error('Cannot remove backup card', error)
    if (orgId.value === id) {
      toast.error(t('billing-backup-card-remove-failed'))
      // Server may have already dropped the card; refresh so retries match reality.
      void loadOverview()
    }
  }
  finally {
    isRemovingBackup.value = false
  }
}

async function openCancel() {
  if (await requireUpdateBilling())
    showCancelModal.value = true
}

async function refreshOrganization() {
  const id = orgId.value
  await organizationStore.fetchOrganizations()
  if (id)
    organizationStore.setCurrentOrganization(id)
}

async function payNow() {
  if (!await requireUpdateBilling() || isPaying.value)
    return
  // No saved card: go straight to the card form.
  if (!card.value) {
    if (canEnterCard.value)
      showCardModal.value = 'invoice'
    else
      toast.error(t('billing-payment-failed'))
    return
  }
  isPaying.value = true
  try {
    const result = await payOpenInvoice(orgId.value)
    if (result.status === 'paid') {
      toast.success(t('billing-invoice-paid'))
      await Promise.all([loadOverview(), refreshOrganization()])
      return
    }
    toast.error(result.message || t('billing-payment-failed'))
    if (canEnterCard.value)
      showCardModal.value = 'invoice'
  }
  catch (error) {
    console.error('Cannot pay invoice', error)
    toast.error(t('billing-payment-failed'))
  }
  finally {
    isPaying.value = false
  }
}

async function resume() {
  if (!await requireUpdateBilling() || isResuming.value)
    return
  isResuming.value = true
  try {
    await resumeSubscription(orgId.value)
    toast.success(t('billing-resume-success'))
    await Promise.all([loadOverview(), refreshOrganization()])
  }
  catch (error) {
    console.error('Cannot resume subscription', error)
    toast.error(t('billing-resume-error'))
  }
  finally {
    isResuming.value = false
  }
}

// cardSaved: the card form just succeeded, so do not ask for a card again even if the
// overview reload failed. id pins the org the user started from.
async function startTrialPlan(options: { id?: string, cardSaved?: boolean } = {}) {
  const id = options.id ?? orgId.value
  if (!id || !await requireUpdateBilling() || isUpdatingTrialPlan.value)
    return
  if (!card.value && !options.cardSaved) {
    scheduleAfterCardSave = true
    showCardModal.value = 'setup'
    return
  }
  isUpdatingTrialPlan.value = true
  try {
    const { plan } = await scheduleTrialPlan(id)
    toast.success(t('trial-plan-scheduled', { plan: plan.planName, date: formatLocalDate(plan.startsAt) }))
    if (id === orgId.value)
      await loadOverview()
  }
  catch (error) {
    console.error('Cannot schedule trial plan', error)
    toast.error(t('trial-plan-schedule-error'))
  }
  finally {
    isUpdatingTrialPlan.value = false
  }
}

async function stopTrialPlan() {
  if (!await requireUpdateBilling() || isUpdatingTrialPlan.value)
    return
  isUpdatingTrialPlan.value = true
  try {
    await cancelTrialPlan(orgId.value)
    toast.success(t('trial-plan-canceled'))
    await loadOverview()
  }
  catch (error) {
    console.error('Cannot cancel trial plan', error)
    toast.error(t('trial-plan-cancel-error'))
  }
  finally {
    isUpdatingTrialPlan.value = false
  }
}

async function openStartNow() {
  if (!await requireUpdateBilling() || isUpdatingTrialPlan.value)
    return
  showStartNowModal.value = true
}

async function onTrialPlanStartedNow() {
  showStartNowModal.value = false
  await Promise.all([loadOverview(), refreshOrganization()])
}

async function onTrialPlanOfferScheduled() {
  const id = trialPlanOfferOrgId.value
  trialPlanOfferOrgId.value = null
  if (id === orgId.value)
    await loadOverview()
}

function closeCardModal() {
  scheduleAfterCardSave = false
  showCardModal.value = null
}

async function onCardSaved() {
  const mode = showCardModal.value
  const id = orgId.value
  const schedule = scheduleAfterCardSave
  scheduleAfterCardSave = false
  showCardModal.value = null
  if (schedule) {
    await startTrialPlan({ id, cardSaved: true })
  }
  else {
    await loadOverview()
    // The user added a card on their own during the trial: offer to start the plan too.
    if (mode === 'setup' && id === orgId.value && trialPlan.value && !trialPlan.value.scheduled)
      trialPlanOfferOrgId.value = id
  }
  if (mode === 'invoice')
    await refreshOrganization()
}

async function onCanceled(sub: BillingSubscription | null) {
  showCancelModal.value = false
  if (overview.value)
    overview.value = { ...overview.value, subscription: sub }
  await refreshOrganization()
}

watch(orgId, () => {
  permissionModal.value = null
  trialPlanOfferOrgId.value = null
  showStartNowModal.value = false
  void loadOverview()
})

onMounted(async () => {
  if (isNativeAppStoreContext()) {
    await router.replace('/settings/organization/usage')
    return
  }
  await organizationStore.awaitInitialLoad()
  // `?oid=<org>` (billing emails): open that org's billing, then drop the param.
  const linkedOrgId = route.query.oid
  if (typeof linkedOrgId === 'string' && linkedOrgId) {
    void router.replace({ query: { ...route.query, oid: undefined } })
    if (linkedOrgId !== orgId.value) {
      organizationStore.setCurrentOrganization(linkedOrgId)
      // The orgId watcher reloads when the switch happened.
      if (linkedOrgId === orgId.value)
        return
    }
  }
  await loadOverview()
})
</script>

<template>
  <div class="relative pb-8">
    <div class="flex flex-col gap-6 px-4 md:px-0">
      <header>
        <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
          {{ t('billing-page-title') }}
        </h1>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ t('billing-page-desc') }}
        </p>
      </header>

      <div v-if="isLoading" class="flex justify-center py-16">
        <span class="d-loading d-loading-spinner d-loading-lg text-blue-500" />
      </div>

      <div v-else-if="loadFailed" class="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200" data-test="billing-load-error">
        <p>{{ t('billing-load-error') }}</p>
        <button type="button" class="d-btn d-btn-sm d-btn-outline mt-3" @click="loadOverview">
          {{ t('retry') }}
        </button>
      </div>

      <template v-else-if="overview">
        <section
          v-if="openInvoice"
          class="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100"
          data-test="billing-open-invoice"
        >
          <div class="flex items-start gap-3">
            <IconExclamationTriangle class="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p class="text-sm font-semibold">
                {{ t('billing-open-invoice-title', { amount: openInvoiceAmount }) }}
              </p>
              <p class="text-xs text-amber-900/80 dark:text-amber-200/80">
                {{ t('past-due-banner-detail') }}
              </p>
            </div>
          </div>
          <button type="button" class="d-btn d-btn-sm d-btn-warning text-black" :disabled="isPaying" data-test="billing-pay-now" @click="payNow">
            <span v-if="isPaying" class="d-loading d-loading-spinner d-loading-xs" />
            {{ t('past-due-banner-pay-now') }}
          </button>
        </section>

        <div class="grid gap-6 md:grid-cols-2">
          <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="billing-subscription">
            <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('billing-subscription-heading') }}
            </h2>
            <p class="mt-3 text-base font-medium text-slate-900 dark:text-white">
              {{ subscriptionLine }}
            </p>
            <p v-if="trialPlan" class="mt-2 text-sm text-slate-600 dark:text-slate-300" data-test="billing-trial-plan">
              {{ trialPlan.scheduled
                ? t('trial-plan-scheduled-line', { plan: trialPlan.planName, price: trialPlanPrice, date: trialPlanDate })
                : t('trial-plan-offer-line', { plan: trialPlan.planName, price: trialPlanPrice, date: trialPlanDate }) }}
            </p>
            <div class="mt-4 flex flex-wrap gap-2">
              <button
                v-if="trialPlan && !trialPlan.scheduled && (card || canEnterCard)"
                type="button"
                class="d-btn d-btn-sm d-btn-primary"
                :disabled="isUpdatingTrialPlan"
                data-test="billing-trial-plan-start"
                @click="startTrialPlan()"
              >
                <span v-if="isUpdatingTrialPlan" class="d-loading d-loading-spinner d-loading-xs" />
                {{ t('trial-plan-start', { plan: trialPlan.planName }) }}
              </button>
              <button
                v-if="canStartTrialPlanNow"
                type="button"
                class="d-btn d-btn-sm"
                :class="trialPlan?.scheduled ? 'd-btn-primary' : 'd-btn-outline'"
                :disabled="isUpdatingTrialPlan"
                data-test="billing-trial-plan-start-now"
                @click="openStartNow"
              >
                {{ t('trial-plan-start-now') }}
              </button>
              <router-link
                to="/settings/organization/plans"
                class="d-btn d-btn-sm"
                :class="trialPlan && !trialPlan.scheduled ? 'd-btn-outline' : 'd-btn-primary'"
              >
                {{ subscription ? t('billing-change-plan') : t('billing-choose-plan') }}
              </router-link>
              <button
                v-if="trialPlan?.scheduled"
                type="button"
                class="d-btn d-btn-sm d-btn-ghost text-slate-600 hover:text-red-600 dark:text-slate-300 dark:hover:text-red-400"
                :disabled="isUpdatingTrialPlan"
                data-test="billing-trial-plan-cancel"
                @click="stopTrialPlan"
              >
                <span v-if="isUpdatingTrialPlan" class="d-loading d-loading-spinner d-loading-xs" />
                {{ t('trial-plan-cancel') }}
              </button>
              <button
                v-if="subscription && (subscription.cancelAtPeriodEnd || subscription.cancelAt)"
                type="button"
                class="d-btn d-btn-sm d-btn-outline"
                :disabled="isResuming"
                data-test="billing-resume"
                @click="resume"
              >
                <span v-if="isResuming" class="d-loading d-loading-spinner d-loading-xs" />
                {{ t('billing-resume') }}
              </button>
              <button
                v-else-if="subscription"
                type="button"
                class="d-btn d-btn-sm d-btn-ghost text-slate-600 hover:text-red-600 dark:text-slate-300 dark:hover:text-red-400"
                data-test="billing-cancel"
                @click="openCancel"
              >
                {{ t('cancel-plan') }}
              </button>
            </div>
          </section>

          <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="billing-payment-method">
            <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('billing-payment-method-heading') }}
            </h2>
            <div v-if="card" class="mt-3 flex items-center gap-3">
              <span class="flex h-10 w-14 items-center justify-center rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700">
                <IconCard class="h-5 w-5" />
              </span>
              <div>
                <p class="text-base font-medium text-slate-900 dark:text-white">
                  {{ brandLabel(card) }} •••• {{ card.last4 }}
                </p>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                  {{ t('billing-card-expires', { month: String(card.expMonth).padStart(2, '0'), year: card.expYear }) }}
                </p>
              </div>
            </div>
            <p v-else class="mt-3 text-sm text-slate-600 dark:text-slate-300">
              {{ t('billing-no-card') }}
            </p>
            <button v-if="canEnterCard" type="button" class="d-btn d-btn-sm d-btn-outline mt-4" data-test="billing-update-card" @click="openCardForm()">
              {{ card ? t('billing-update-card') : t('billing-add-card') }}
            </button>

            <div v-if="card && backupCard" class="mt-5 border-t border-slate-100 pt-4 dark:border-white/10" data-test="billing-backup-card">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {{ t('billing-backup-card-heading') }}
              </h3>
              <div class="mt-2 flex items-center gap-3">
                <span class="flex h-8 w-11 items-center justify-center rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700">
                  <IconCard class="h-4 w-4" />
                </span>
                <div>
                  <p class="text-sm font-medium text-slate-900 dark:text-white">
                    {{ brandLabel(backupCard) }} •••• {{ backupCard.last4 }}
                  </p>
                  <p class="text-xs text-slate-500 dark:text-slate-400">
                    {{ t('billing-card-expires', { month: String(backupCard.expMonth).padStart(2, '0'), year: backupCard.expYear }) }}
                  </p>
                </div>
              </div>
              <div class="mt-3 flex flex-wrap gap-2">
                <button v-if="canEnterCard" type="button" class="d-btn d-btn-xs d-btn-outline" data-test="billing-replace-backup-card" @click="openCardForm('backup')">
                  {{ t('billing-backup-card-replace') }}
                </button>
                <button
                  type="button"
                  class="d-btn d-btn-xs d-btn-ghost text-slate-600 hover:text-red-600 dark:text-slate-300 dark:hover:text-red-400"
                  :disabled="isRemovingBackup"
                  data-test="billing-remove-backup-card"
                  @click="removeBackup"
                >
                  <span v-if="isRemovingBackup" class="d-loading d-loading-spinner d-loading-xs" />
                  {{ t('billing-backup-card-remove') }}
                </button>
              </div>
            </div>
            <div
              v-else-if="card && canEnterCard"
              class="mt-5 flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-blue-950 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-100"
              data-test="billing-backup-card-recommendation"
            >
              <IconShieldCheck class="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-300" />
              <div>
                <p class="text-sm font-semibold">
                  {{ t('billing-backup-card-recommendation-title') }}
                </p>
                <p class="mt-0.5 text-xs text-blue-900/80 dark:text-blue-200/80">
                  {{ t('billing-backup-card-recommendation-desc') }}
                </p>
                <button type="button" class="d-btn d-btn-xs d-btn-primary mt-2" data-test="billing-add-backup-card" @click="openCardForm('backup')">
                  {{ t('billing-backup-card-add') }}
                </button>
              </div>
            </div>
          </section>
        </div>

        <section class="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="billing-invoices">
          <h2 class="border-b border-slate-100 px-5 py-4 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:border-white/10 dark:text-slate-400">
            {{ t('billing-invoices-heading') }}
          </h2>
          <p v-if="!invoices.length" class="px-5 py-6 text-sm text-slate-600 dark:text-slate-300">
            {{ t('billing-no-invoices') }}
          </p>
          <ul v-else class="divide-y divide-slate-100 dark:divide-white/10">
            <li v-for="invoice in invoices" :key="invoice.id" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <span class="w-28 shrink-0 text-slate-900 dark:text-white">{{ formatLocalDate(invoice.created) }}</span>
              <span class="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">{{ invoice.number ?? invoice.id }}</span>
              <span class="w-24 text-right font-medium text-slate-900 tabular-nums dark:text-white">{{ formatStripeAmount(invoice.total, invoice.currency) }}</span>
              <span class="inline-flex w-24 justify-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset" :class="invoiceStatusClass(invoice.status)">
                {{ t(`billing-invoice-status-${invoice.status ?? 'void'}`) }}
              </span>
              <a
                v-if="invoice.pdfUrl"
                :href="invoice.pdfUrl"
                class="d-btn d-btn-ghost d-btn-xs gap-1"
                :aria-label="t('billing-download-invoice')"
                download
              >
                <IconDownload class="h-4 w-4" />
                PDF
              </a>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <CardFormModal
      v-if="showCardModal"
      :org-id="orgId"
      :mode="showCardModal"
      :amount-label="openInvoiceAmount"
      @close="closeCardModal"
      @saved="onCardSaved"
    />
    <TrialPlanOfferModal
      v-if="trialPlanOfferOrgId"
      :org-id="trialPlanOfferOrgId"
      source="billing"
      @close="trialPlanOfferOrgId = null"
      @scheduled="onTrialPlanOfferScheduled"
    />
    <TrialPlanStartNowModal
      v-if="showStartNowModal && trialPlan && card"
      :org-id="orgId"
      :plan="trialPlan"
      :card="card"
      :trial-days-left="trialDaysLeft"
      source="billing"
      @close="showStartNowModal = false"
      @started="onTrialPlanStartedNow"
      @stale="onTrialPlanStartedNow"
    />
    <CancelPlanModal
      v-if="showCancelModal"
      :org-id="orgId"
      @close="showCancelModal = false"
      @canceled="onCanceled"
    />
    <RbacPermissionOnlyModal
      v-if="permissionModal"
      :title="t('billing-access-required')"
      :permission="permissionModal"
      @close="permissionModal = null"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
