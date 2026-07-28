<script setup lang="ts">
import { computedAsync } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false,
})

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const supabase = useSupabase()
const isLoading = ref(false)

const { currentOrganization } = storeToRefs(organizationStore)

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
}

type EmailPreferenceKey = keyof EmailPreferences

const emailPrefs = computed<EmailPreferences>(() => {
  const prefs = (currentOrganization.value as any)?.email_preferences as EmailPreferences | null | undefined
  return prefs ?? {}
})

function getEmailPref(key: EmailPreferenceKey): boolean {
  return emailPrefs.value[key] ?? true
}

const hasOrgPerm = computedAsync(async () => {
  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.update_settings', { orgId })
}, false)

async function toggleEmailPref(key: EmailPreferenceKey) {
  if (!currentOrganization.value?.gid || !hasOrgPerm.value) {
    toast.error(t('no-permission'))
    return
  }

  isLoading.value = true
  const currentPrefs = emailPrefs.value
  const newValue = !(currentPrefs[key] ?? true)
  const updatedPrefs = { ...currentPrefs, [key]: newValue }

  const { data, error } = await supabase
    .from('orgs')
    .update({
      email_preferences: updatedPrefs,
    } as any)
    .eq('id', currentOrganization.value.gid)
    .select()
    .single()

  if (error) {
    toast.error(t('org-notification-update-failed'))
    console.error('Failed to update org email preferences:', error)
  }
  else if (data) {
    if (currentOrganization.value)
      (currentOrganization.value as any).email_preferences = updatedPrefs
    toast.success(t('org-notification-updated'))
  }

  isLoading.value = false
}
</script>

<template>
  <div
    class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg grow md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900"
    :class="{ 'border-0 shadow-none md:rounded-none': embedded }"
  >
    <div class="p-6 space-y-6">
      <h2 class="text-2xl font-bold dark:text-white text-slate-800">
        {{ t('org-notifications-title') }}
      </h2>

      <p class="text-sm text-slate-600 dark:text-slate-400">
        {{ t('org-notifications-description') }}
      </p>

      <div class="w-full mx-auto dark:text-white">
        <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
          {{ t('notifications-usage-alerts') }}
        </h3>
        <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
          <InfoRow :label="t('notifications-usage-limit')" :editable="false" :value="t('org-notifications-usage-limit-desc')">
            <Toggle
              :value="getEmailPref('usage_limit')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('usage_limit')"
            />
          </InfoRow>
          <InfoRow :label="t('notifications-credit-usage')" :editable="false" :value="t('org-notifications-credit-usage-desc')">
            <Toggle
              :value="getEmailPref('credit_usage')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('credit_usage')"
            />
          </InfoRow>
        </dl>

        <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
          {{ t('notifications-activity') }}
        </h3>
        <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
          <InfoRow :label="t('notifications-bundle-created')" :editable="false" :value="t('org-notifications-bundle-created-desc')">
            <Toggle
              :value="getEmailPref('bundle_created')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('bundle_created')"
            />
          </InfoRow>
          <InfoRow :label="t('notifications-bundle-deployed')" :editable="false" :value="t('org-notifications-bundle-deployed-desc')">
            <Toggle
              :value="getEmailPref('bundle_deployed')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('bundle_deployed')"
            />
          </InfoRow>
          <InfoRow :label="t('notifications-deploy-stats')" :editable="false" :value="t('org-notifications-deploy-stats-desc')">
            <Toggle
              :value="getEmailPref('deploy_stats_24h')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('deploy_stats_24h')"
            />
          </InfoRow>
        </dl>

        <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
          {{ t('notifications-statistics') }}
        </h3>
        <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
          <InfoRow :label="t('notifications-weekly-stats')" :editable="false" :value="t('org-notifications-weekly-stats-desc')">
            <Toggle
              :value="getEmailPref('weekly_stats')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('weekly_stats')"
            />
          </InfoRow>
          <InfoRow :label="t('notifications-monthly-stats')" :editable="false" :value="t('org-notifications-monthly-stats-desc')">
            <Toggle
              :value="getEmailPref('monthly_stats')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('monthly_stats')"
            />
          </InfoRow>
          <InfoRow :label="t('notifications-billing-period-stats')" :editable="false" :value="t('org-notifications-billing-period-stats-desc')">
            <Toggle
              :value="getEmailPref('billing_period_stats')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('billing_period_stats')"
            />
          </InfoRow>
        </dl>

        <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
          {{ t('notifications-issues') }}
        </h3>
        <dl class="divide-y divide-slate-200 dark:divide-slate-500 mb-8">
          <InfoRow :label="t('notifications-device-error')" :editable="false" :value="t('org-notifications-device-error-desc')">
            <Toggle
              :value="getEmailPref('device_error')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('device_error')"
            />
          </InfoRow>
          <InfoRow :label="t('notifications-channel-self-rejected')" :editable="false" :value="t('org-notifications-channel-self-rejected-desc')">
            <Toggle
              :value="getEmailPref('channel_self_rejected')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('channel_self_rejected')"
            />
          </InfoRow>
        </dl>

        <h3 class="text-lg font-semibold mb-4 dark:text-white text-slate-700">
          {{ t('notifications-onboarding') }}
        </h3>
        <dl class="divide-y divide-slate-200 dark:divide-slate-500">
          <InfoRow :label="t('notifications-onboarding-emails')" :editable="false" :value="t('org-notifications-onboarding-desc')">
            <Toggle
              :value="getEmailPref('onboarding')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('onboarding')"
            />
          </InfoRow>
          <InfoRow :label="t('notifications-builder-onboarding')" :editable="false" :value="t('org-notifications-builder-onboarding-desc')">
            <Toggle
              :value="getEmailPref('builder_onboarding')"
              :disabled="!hasOrgPerm"
              @change="toggleEmailPref('builder_onboarding')"
            />
          </InfoRow>
        </dl>
      </div>
    </div>
  </div>
</template>
