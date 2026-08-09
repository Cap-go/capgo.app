<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconCheck from '~icons/lucide/check'
import IconLoader from '~icons/lucide/loader-2'
import Toggle from '~/components/Toggle.vue'
import { invokeCapgoApi } from '~/services/capgoApi'

const PUBLIC_EMAIL_PREFERENCE_KEYS = [
  'usage_limit',
  'credit_usage',
  'onboarding',
  'builder_onboarding',
  'weekly_stats',
  'monthly_stats',
  'billing_period_stats',
  'deploy_stats_24h',
  'bundle_created',
  'bundle_deployed',
  'device_error',
  'channel_self_rejected',
  'bundle_incompatible',
] as const

type PublicEmailPreferenceKey = typeof PUBLIC_EMAIL_PREFERENCE_KEYS[number]

const PREFERENCE_SECTIONS: {
  titleKey: string
  keys: PublicEmailPreferenceKey[]
}[] = [
  {
    titleKey: 'notifications-usage-alerts',
    keys: ['usage_limit', 'credit_usage'],
  },
  {
    titleKey: 'notifications-activity',
    keys: ['bundle_created', 'bundle_deployed', 'deploy_stats_24h'],
  },
  {
    titleKey: 'notifications-statistics',
    keys: ['weekly_stats', 'monthly_stats', 'billing_period_stats'],
  },
  {
    titleKey: 'notifications-issues',
    keys: ['device_error', 'channel_self_rejected', 'bundle_incompatible'],
  },
  {
    titleKey: 'notifications-onboarding',
    keys: ['onboarding', 'builder_onboarding'],
  },
]

const PREFERENCE_LABEL_KEYS: Record<PublicEmailPreferenceKey, string> = {
  usage_limit: 'notifications-usage-limit',
  credit_usage: 'notifications-credit-usage',
  onboarding: 'notifications-onboarding-emails',
  builder_onboarding: 'notifications-builder-onboarding',
  weekly_stats: 'notifications-weekly-stats',
  monthly_stats: 'notifications-monthly-stats',
  billing_period_stats: 'notifications-billing-period-stats',
  deploy_stats_24h: 'notifications-deploy-stats',
  bundle_created: 'notifications-bundle-created',
  bundle_deployed: 'notifications-bundle-deployed',
  device_error: 'notifications-device-error',
  channel_self_rejected: 'notifications-channel-self-rejected',
  bundle_incompatible: 'notifications-bundle-incompatible',
}

const PREFERENCE_DESC_KEYS: Record<PublicEmailPreferenceKey, string> = {
  usage_limit: 'notifications-usage-limit-desc',
  credit_usage: 'notifications-credit-usage-desc',
  onboarding: 'notifications-onboarding-emails-desc',
  builder_onboarding: 'notifications-builder-onboarding-desc',
  weekly_stats: 'notifications-weekly-stats-desc',
  monthly_stats: 'notifications-monthly-stats-desc',
  billing_period_stats: 'notifications-billing-period-stats-desc',
  deploy_stats_24h: 'notifications-deploy-stats-desc',
  bundle_created: 'notifications-bundle-created-desc',
  bundle_deployed: 'notifications-bundle-deployed-desc',
  device_error: 'notifications-device-error-desc',
  channel_self_rejected: 'notifications-channel-self-rejected-desc',
  bundle_incompatible: 'notifications-bundle-incompatible-desc',
}

const { t } = useI18n()
const route = useRoute('/email-preferences')

const email = ref(String(route.query.email ?? '').trim())
const unsubscribeAll = ref(false)
const enableNotifications = ref(true)
const optForNewsletters = ref(true)
const isSaving = ref(false)
const isSaved = ref(false)
const formError = ref<string | null>(null)

const preferences = reactive<Record<PublicEmailPreferenceKey, boolean>>(
  Object.fromEntries(
    PUBLIC_EMAIL_PREFERENCE_KEYS.map(key => [key, true]),
  ) as Record<PublicEmailPreferenceKey, boolean>,
)

const emailLooksValid = computed(() => {
  const value = email.value.trim()
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@'))
    return false
  const domain = value.slice(at + 1)
  return domain.includes('.') && !value.includes(' ')
})

async function savePreferences() {
  formError.value = null
  if (!emailLooksValid.value) {
    formError.value = t('email-preferences-invalid-email')
    return
  }

  isSaving.value = true
  isSaved.value = false
  try {
    await invokeCapgoApi('private/email_preferences', {
      allowAnonymous: true,
      body: {
        email: email.value.trim().toLowerCase(),
        unsubscribe_all: unsubscribeAll.value,
        enable_notifications: unsubscribeAll.value ? false : enableNotifications.value,
        opt_for_newsletters: unsubscribeAll.value ? false : optForNewsletters.value,
        preferences: unsubscribeAll.value
          ? Object.fromEntries(PUBLIC_EMAIL_PREFERENCE_KEYS.map(key => [key, false]))
          : { ...preferences },
      },
    })
  }
  finally {
    // Always confirm save — backend never reveals whether the account exists.
    isSaved.value = true
    isSaving.value = false
  }
}
</script>

<template>
  <div class="min-h-dvh bg-slate-50 px-4 py-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] dark:bg-slate-950">
    <div class="mx-auto w-full max-w-xl">
      <header class="mb-6 flex items-center gap-3">
        <img src="/capgo.webp" alt="Capgo" class="h-9 w-9 rounded-md invert dark:invert-0">
        <div>
          <p class="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
            Capgo
          </p>
          <h1 class="text-xl font-semibold text-slate-900 dark:text-white">
            {{ t('email-preferences-title') }}
          </h1>
        </div>
      </header>

      <p class="mb-6 text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ t('email-preferences-description') }}
      </p>

      <form class="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6" @submit.prevent="savePreferences">
        <div>
          <label for="email-preferences-email" class="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {{ t('email') }}
          </label>
          <input
            id="email-preferences-email"
            v-model="email"
            type="email"
            autocomplete="email"
            required
            class="d-input d-input-bordered w-full bg-white dark:bg-slate-950"
            :aria-invalid="!emailLooksValid && email.length > 0"
          >
        </div>

        <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60">
          <label class="flex items-start justify-between gap-4">
            <span>
              <span class="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                {{ t('email-preferences-unsubscribe-all') }}
              </span>
              <span class="mt-1 block text-sm text-slate-500 dark:text-slate-400">
                {{ t('email-preferences-unsubscribe-all-desc') }}
              </span>
            </span>
            <Toggle v-model:value="unsubscribeAll" />
          </label>
        </div>

        <div v-show="!unsubscribeAll" class="space-y-6">
          <div>
            <h2 class="mb-3 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {{ t('notifications-general') }}
            </h2>
            <div class="space-y-3">
              <label class="flex items-start justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3 dark:border-slate-700">
                <span>
                  <span class="block text-sm font-medium text-slate-800 dark:text-slate-100">{{ t('activation-notification') }}</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">{{ t('activation-notification-desc') }}</span>
                </span>
                <Toggle v-model:value="enableNotifications" />
              </label>
              <label class="flex items-start justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3 dark:border-slate-700">
                <span>
                  <span class="block text-sm font-medium text-slate-800 dark:text-slate-100">{{ t('activation-doi') }}</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">{{ t('activation-doi-desc') }}</span>
                </span>
                <Toggle v-model:value="optForNewsletters" />
              </label>
            </div>
          </div>

          <div v-for="section in PREFERENCE_SECTIONS" :key="section.titleKey">
            <h2 class="mb-3 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {{ t(section.titleKey) }}
            </h2>
            <div class="space-y-3">
              <label
                v-for="key in section.keys"
                :key="key"
                class="flex items-start justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3 dark:border-slate-700"
              >
                <span>
                  <span class="block text-sm font-medium text-slate-800 dark:text-slate-100">{{ t(PREFERENCE_LABEL_KEYS[key]) }}</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">{{ t(PREFERENCE_DESC_KEYS[key]) }}</span>
                </span>
                <Toggle v-model:value="preferences[key]" />
              </label>
            </div>
          </div>
        </div>

        <p v-if="formError" class="text-sm text-red-600 dark:text-red-400" role="alert">
          {{ formError }}
        </p>
        <p v-else-if="isSaved" class="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400" role="status">
          <IconCheck class="h-4 w-4" aria-hidden="true" />
          {{ t('email-preferences-saved') }}
        </p>

        <button
          type="submit"
          class="d-btn inline-flex w-full items-center justify-center gap-2 rounded-xl border-0 bg-[#119eff] px-4 py-3 text-base font-semibold text-white hover:brightness-105 disabled:opacity-60"
          :disabled="isSaving"
        >
          <IconLoader v-if="isSaving" class="h-4 w-4 animate-spin" aria-hidden="true" />
          {{ isSaving ? t('saving') : t('email-preferences-save') }}
        </button>
      </form>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
