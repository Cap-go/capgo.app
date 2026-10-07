<script setup lang="ts">
import { computedAsync } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconGlobe from '~icons/lucide/globe'
import IconLoader from '~icons/lucide/loader-circle'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { normalizeWebsiteLiveUrl, useAppUpdateModeStore } from '~/stores/appUpdateMode'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{ appId: string }>()

const { t } = useI18n()
const router = useRouter()
const appUpdateModeStore = useAppUpdateModeStore()
const organizationStore = useOrganizationStore()
const mainStore = useMainStore()

const state = computed(() => appUpdateModeStore.get(props.appId))
const isWebsiteMode = computed(() => state.value?.updateMode === 'website')
const websiteUrlInput = ref('')
const isSavingUrl = ref(false)
const showUpgrade = ref(false)
const upgradeAcknowledged = ref(false)
const isUpgrading = ref(false)

const canUpdateSettings = computedAsync(async () => {
  return await checkPermissions('app.update_settings', { appId: props.appId })
}, false)

// The app's owner org, not the selected org: app URLs can point to another org.
const appOrgId = computed(() => organizationStore.getOrgByAppId(props.appId)?.gid ?? organizationStore.currentOrganization?.gid ?? '')
const isPlanLoading = ref(false)
// Read the plan directly: the shared helper falls back to 'Solo' when the
// user cannot read billing, which would wrongly look like a full plan.
const currentPlanName = computedAsync(async () => {
  if (!appOrgId.value)
    return null
  const { data, error } = await useSupabase()
    .rpc('get_current_plan_name_org', { orgid: appOrgId.value })
    .single()
  if (error || typeof data !== 'string' || !data)
    return null
  return data
}, null, isPlanLoading)
const isPlanUnreadable = computed(() => !isPlanLoading.value && currentPlanName.value === null)
const isPlanKnown = computed(() => !isPlanLoading.value && currentPlanName.value !== null)
// Website Live is identified by plan kind, not by its display name.
const websitePlanNames = computed(() => new Set(mainStore.plans.filter(plan => plan.kind === 'website').map(plan => plan.name)))
const needsFullPlan = computed(() => !!currentPlanName.value && websitePlanNames.value.has(currentPlanName.value))
// Recovery path: a classic-mode app in a Website Live org (for example when
// onboarding could not save the website) can still be switched to the website.
const showEnableWebsiteLive = computed(() => !!state.value && !isWebsiteMode.value && needsFullPlan.value)

watch(() => props.appId, appId => void appUpdateModeStore.load(appId, true), { immediate: true })
// Keep what the user is typing; only sync from the store while untouched.
const isUrlDirty = ref(false)
watch(state, (value) => {
  if (!isUrlDirty.value)
    websiteUrlInput.value = value?.websiteUrl ?? ''
}, { immediate: true })

const upgradeSteps = computed(() => [
  { key: 'plan', title: t('website-live-upgrade-step-plan'), done: currentPlanName.value !== null && !needsFullPlan.value },
  { key: 'cli', title: t('website-live-upgrade-step-cli'), done: false },
  { key: 'upload', title: t('website-live-upgrade-step-upload'), done: false },
  { key: 'plugin', title: t('website-live-upgrade-step-plugin'), done: false },
])

async function saveWebsiteUrl() {
  if (!canUpdateSettings.value) {
    toast.error(t('no-permission'))
    return
  }
  const websiteUrl = normalizeWebsiteLiveUrl(websiteUrlInput.value)
  if (!websiteUrl) {
    toast.error(t('website-live-invalid-url'))
    return
  }
  isSavingUrl.value = true
  try {
    await appUpdateModeStore.save(props.appId, { updateMode: 'website', websiteUrl })
    isUrlDirty.value = false
    websiteUrlInput.value = websiteUrl
    toast.success(t('website-live-url-saved'))
  }
  catch (error) {
    console.error('Cannot save Website Live URL', error)
    toast.error(t('website-live-url-save-error'))
  }
  finally {
    isSavingUrl.value = false
  }
}

async function upgradeToFullCapgo() {
  if (!canUpdateSettings.value) {
    toast.error(t('no-permission'))
    return
  }
  if (!upgradeAcknowledged.value || !isPlanKnown.value)
    return
  // Classic updates need a full plan: switching first would stop website
  // updates until the plan changes, so send the user to the plans page first.
  if (needsFullPlan.value) {
    await router.push('/settings/organization/plans')
    return
  }
  isUpgrading.value = true
  try {
    // Keep website_url so the user can switch back without retyping it.
    await appUpdateModeStore.save(props.appId, { updateMode: 'capgo', websiteUrl: state.value?.websiteUrl ?? null })
    toast.success(t('website-live-upgrade-done'))
    await router.push(`/app/${encodeURIComponent(props.appId)}/getting-started`)
  }
  catch (error) {
    console.error('Cannot switch app to full Capgo', error)
    toast.error(t('website-live-upgrade-error'))
  }
  finally {
    isUpgrading.value = false
  }
}
</script>

<template>
  <section
    v-if="isWebsiteMode"
    class="rounded-2xl border border-azure-500/30 bg-azure-500/5 p-5 dark:border-azure-500/30 dark:bg-azure-500/10"
    data-test="website-live-settings"
  >
    <div class="flex items-start gap-3">
      <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-azure-500 text-white">
        <IconGlobe class="h-5 w-5" aria-hidden="true" />
      </span>
      <div>
        <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
          {{ t('website-live-settings-title') }}
        </h3>
        <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('website-live-settings-description') }}
        </p>
      </div>
    </div>

    <div class="mt-4">
      <label for="website-live-url" class="text-sm font-medium text-slate-800 dark:text-slate-200">
        {{ t('website-live-url-label') }}
      </label>
      <div class="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="website-live-url"
          v-model="websiteUrlInput"
          type="url"
          inputmode="url"
          placeholder="https://app.example.com"
          data-test="website-live-url"
          :disabled="!canUpdateSettings"
          class="d-input min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          @input="isUrlDirty = true"
          @keydown.enter.prevent="saveWebsiteUrl"
        >
        <button
          type="button"
          class="d-btn d-btn-primary min-h-10"
          data-test="website-live-save-url"
          :disabled="isSavingUrl || !canUpdateSettings"
          @click="saveWebsiteUrl"
        >
          <IconLoader v-if="isSavingUrl" class="h-4 w-4 animate-spin" aria-hidden="true" />
          {{ t('website-live-save-url') }}
        </button>
      </div>
      <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
        {{ t('website-live-url-help') }}
      </p>
    </div>

    <div class="mt-5 border-t border-slate-200 pt-4 dark:border-slate-700">
      <button
        v-if="!showUpgrade"
        type="button"
        class="d-btn min-h-10"
        data-test="website-live-show-upgrade"
        @click="showUpgrade = true"
      >
        {{ t('website-live-upgrade-cta') }}
        <IconArrowRight class="h-4 w-4" aria-hidden="true" />
      </button>

      <div v-else data-test="website-live-upgrade">
        <h4 class="text-base font-semibold text-slate-900 dark:text-white">
          {{ t('website-live-upgrade-title') }}
        </h4>
        <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('website-live-upgrade-description') }}
        </p>
        <ol class="mt-3 space-y-2">
          <li v-for="(step, index) in upgradeSteps" :key="step.key" class="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-200">
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
              :class="step.done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300'"
              aria-hidden="true"
            >
              <IconCheck v-if="step.done" class="h-3.5 w-3.5" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="pt-0.5">{{ step.title }}</span>
          </li>
        </ol>
        <p v-if="isPlanUnreadable" class="mt-3 text-sm text-amber-700 dark:text-amber-300" data-test="website-live-plan-unreadable">
          {{ t('website-live-upgrade-plan-unknown') }}
        </p>
        <p v-if="needsFullPlan" class="mt-3 text-sm text-amber-700 dark:text-amber-300">
          {{ t('website-live-upgrade-plan-required') }}
        </p>
        <label class="mt-4 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input v-model="upgradeAcknowledged" type="checkbox" class="d-checkbox d-checkbox-sm mt-0.5" data-test="website-live-upgrade-ack">
          <span>{{ t('website-live-upgrade-ack') }}</span>
        </label>
        <div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" class="d-btn min-h-10" @click="showUpgrade = false">
            {{ t('button-cancel') }}
          </button>
          <button
            type="button"
            class="d-btn d-btn-primary min-h-10"
            data-test="website-live-confirm-upgrade"
            :disabled="!upgradeAcknowledged || isUpgrading || !canUpdateSettings || !isPlanKnown"
            @click="upgradeToFullCapgo"
          >
            <IconLoader v-if="isUpgrading" class="h-4 w-4 animate-spin" aria-hidden="true" />
            {{ needsFullPlan ? t('website-live-upgrade-confirm-plan') : t('website-live-upgrade-confirm') }}
          </button>
        </div>
      </div>
    </div>
  </section>
  <section
    v-else-if="showEnableWebsiteLive"
    class="rounded-2xl border border-amber-300/60 bg-amber-50 p-5 dark:border-amber-400/30 dark:bg-amber-500/10"
    data-test="website-live-enable"
  >
    <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
      {{ t('website-live-enable-title') }}
    </h3>
    <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
      {{ t('website-live-enable-description') }}
    </p>
    <label for="website-live-enable-url" class="mt-4 block text-sm font-medium text-slate-800 dark:text-slate-200">
      {{ t('website-live-url-label') }}
    </label>
    <div class="mt-2 flex flex-col gap-2 sm:flex-row">
      <input
        id="website-live-enable-url"
        v-model="websiteUrlInput"
        type="url"
        inputmode="url"
        placeholder="https://app.example.com"
        data-test="website-live-enable-url"
        :disabled="!canUpdateSettings"
        class="d-input min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
        @input="isUrlDirty = true"
        @keydown.enter.prevent="saveWebsiteUrl"
      >
      <button
        type="button"
        class="d-btn d-btn-primary min-h-10"
        data-test="website-live-enable-save"
        :disabled="isSavingUrl || !canUpdateSettings"
        @click="saveWebsiteUrl"
      >
        <IconLoader v-if="isSavingUrl" class="h-4 w-4 animate-spin" aria-hidden="true" />
        {{ t('website-live-enable-cta') }}
      </button>
    </div>
  </section>
</template>
