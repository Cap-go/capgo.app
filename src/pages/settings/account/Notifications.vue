<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
// tabs handled by settings layout

const { t } = useI18n()
const main = useMainStore()
const supabase = useSupabase()
const isLoading = ref(false)
const enableNotifications = ref(main.user?.enable_notifications ?? true)
const optForNewsletters = ref(main.user?.opt_for_newsletters ?? true)
const displayStore = useDisplayStore()
displayStore.NavTitle = t('notifications')

// Email preferences with defaults
interface EmailPreferences {
  usage_limit?: boolean
  credit_usage?: boolean
  onboarding?: boolean
  builder_onboarding?: boolean
  weekly_stats?: boolean
  monthly_stats?: boolean
  billing_period_stats?: boolean
  deploy_stats_24h?: boolean
  bundle_created?: boolean
  bundle_deployed?: boolean
  device_error?: boolean
  channel_self_rejected?: boolean
  bundle_incompatible?: boolean
  cli_realtime_feed?: boolean
}

type EmailPreferenceKey = keyof EmailPreferences

const emailPrefs = computed<EmailPreferences>(() => {
  // email_preferences is a JSONB column added in migration 20251228064121
  const prefs = (main.user as any)?.email_preferences as EmailPreferences | null | undefined
  return prefs ?? {}
})

function getEmailPref(key: EmailPreferenceKey): boolean {
  return emailPrefs.value[key] ?? true
}

async function submitNotif() {
  if (!main.user?.id)
    return

  isLoading.value = true
  enableNotifications.value = !enableNotifications.value
  const { data, error } = await supabase
    .from('users')
    .update({
      enable_notifications: enableNotifications.value,
    })
    .eq('id', main.user.id)
    .select()
    .single()
  if (!error && data)
    main.user = data
  isLoading.value = false
}

async function submitDoi() {
  if (!main.user?.id)
    return

  isLoading.value = true

  optForNewsletters.value = !optForNewsletters.value
  const { data, error } = await supabase
    .from('users')
    .update({
      opt_for_newsletters: optForNewsletters.value,
    })
    .eq('id', main.user.id)
    .select()
    .single()
  if (!error && data)
    main.user = data
  isLoading.value = false
}

async function toggleEmailPref(key: EmailPreferenceKey) {
  if (!main.user?.id)
    return

  isLoading.value = true
  const currentPrefs = emailPrefs.value
  const newValue = !(currentPrefs[key] ?? true)
  const updatedPrefs = { ...currentPrefs, [key]: newValue }

  // email_preferences is a JSONB column added in migration 20251228064121
  const { data, error } = await supabase
    .from('users')
    .update({
      email_preferences: updatedPrefs,
    } as any)
    .eq('id', main.user.id)
    .select()
    .single()
  if (!error && data)
    main.user = data
  isLoading.value = false
}
</script>

<template>
  <div>
    <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-sm grow md:rounded-xl dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
      <!-- Panel body -->
      <div class="p-6 space-y-6">
        <h2 class="text-2xl font-bold dark:text-white text-slate-800">
          {{ t('my-notifications') }}
        </h2>

        <div class="w-full mx-auto dark:text-white">
          <!-- General Settings Section -->
          <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
            {{ t('notifications-general') }}
          </h3>
          <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
            <InfoRow :label="t('activation-notification')" :editable="false" :value="t('activation-notification-desc')">
              <Toggle
                :value="enableNotifications"
                @change="submitNotif()"
              />
            </InfoRow>
            <InfoRow :label="t('activation-doi')" :editable="false" :value="t('activation-doi-desc')">
              <Toggle
                :value="optForNewsletters"
                @change="submitDoi()"
              />
            </InfoRow>
          </dl>

          <!-- Usage Alerts Section -->
          <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
            {{ t('notifications-usage-alerts') }}
          </h3>
          <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
            <InfoRow :label="t('notifications-usage-limit')" :editable="false" :value="t('notifications-usage-limit-desc')">
              <Toggle
                :value="getEmailPref('usage_limit')"
                @change="toggleEmailPref('usage_limit')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-credit-usage')" :editable="false" :value="t('notifications-credit-usage-desc')">
              <Toggle
                :value="getEmailPref('credit_usage')"
                @change="toggleEmailPref('credit_usage')"
              />
            </InfoRow>
          </dl>

          <!-- Activity Notifications Section -->
          <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
            {{ t('notifications-activity') }}
          </h3>
          <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
            <InfoRow :label="t('notifications-bundle-created')" :editable="false" :value="t('notifications-bundle-created-desc')">
              <Toggle
                :value="getEmailPref('bundle_created')"
                @change="toggleEmailPref('bundle_created')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-bundle-deployed')" :editable="false" :value="t('notifications-bundle-deployed-desc')">
              <Toggle
                :value="getEmailPref('bundle_deployed')"
                @change="toggleEmailPref('bundle_deployed')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-deploy-stats')" :editable="false" :value="t('notifications-deploy-stats-desc')">
              <Toggle
                :value="getEmailPref('deploy_stats_24h')"
                @change="toggleEmailPref('deploy_stats_24h')"
              />
            </InfoRow>
          </dl>

          <!-- Statistics Section -->
          <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
            {{ t('notifications-statistics') }}
          </h3>
          <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
            <InfoRow :label="t('notifications-weekly-stats')" :editable="false" :value="t('notifications-weekly-stats-desc')">
              <Toggle
                :value="getEmailPref('weekly_stats')"
                @change="toggleEmailPref('weekly_stats')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-monthly-stats')" :editable="false" :value="t('notifications-monthly-stats-desc')">
              <Toggle
                :value="getEmailPref('monthly_stats')"
                @change="toggleEmailPref('monthly_stats')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-billing-period-stats')" :editable="false" :value="t('notifications-billing-period-stats-desc')">
              <Toggle
                :value="getEmailPref('billing_period_stats')"
                @change="toggleEmailPref('billing_period_stats')"
              />
            </InfoRow>
          </dl>

          <!-- Issues & Errors Section -->
          <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
            {{ t('notifications-issues') }}
          </h3>
          <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
            <InfoRow :label="t('notifications-device-error')" :editable="false" :value="t('notifications-device-error-desc')">
              <Toggle
                :value="getEmailPref('device_error')"
                @change="toggleEmailPref('device_error')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-channel-self-rejected')" :editable="false" :value="t('notifications-channel-self-rejected-desc')">
              <Toggle
                :value="getEmailPref('channel_self_rejected')"
                @change="toggleEmailPref('channel_self_rejected')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-bundle-incompatible')" :editable="false" :value="t('notifications-bundle-incompatible-desc')">
              <Toggle
                :value="getEmailPref('bundle_incompatible')"
                @change="toggleEmailPref('bundle_incompatible')"
              />
            </InfoRow>
          </dl>

          <!-- Realtime CLI Feed Section -->
          <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
            {{ t('notifications-realtime') }}
          </h3>
          <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
            <InfoRow :label="t('notifications-cli-realtime-feed')" :editable="false" :value="t('notifications-cli-realtime-feed-desc')">
              <Toggle
                :value="getEmailPref('cli_realtime_feed')"
                @change="toggleEmailPref('cli_realtime_feed')"
              />
            </InfoRow>
          </dl>

          <!-- Onboarding Section -->
          <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
            {{ t('notifications-onboarding') }}
          </h3>
          <dl class="divide-y divide-slate-200 dark:divide-slate-500">
            <InfoRow :label="t('notifications-onboarding-emails')" :editable="false" :value="t('notifications-onboarding-emails-desc')">
              <Toggle
                :value="getEmailPref('onboarding')"
                @change="toggleEmailPref('onboarding')"
              />
            </InfoRow>
            <InfoRow :label="t('notifications-builder-onboarding')" :editable="false" :value="t('notifications-builder-onboarding-desc')">
              <Toggle
                :value="getEmailPref('builder_onboarding')"
                @change="toggleEmailPref('builder_onboarding')"
              />
            </InfoRow>
          </dl>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
