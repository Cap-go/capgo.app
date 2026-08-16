<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const organizationStore = useOrganizationStore()
const hideExternalPurchaseFlows = isNativeAppStoreContext()

// Password policy takes priority over subscription
const needsPasswordUpdate = computed(() => {
  const org = organizationStore.currentOrganization
  return org?.password_policy_config?.enabled && org?.password_has_access === false
})

// 2FA enforcement takes priority after password policy
const needs2FASetup = computed(() => {
  const org = organizationStore.currentOrganization
  return org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
})

// Show copy org ID button when in organization settings
const showCopyOrgId = computed(() => {
  return route.path.startsWith('/settings/organization')
})

function goToPlans() {
  router.push('/settings/organization/plans')
}

function goToChangePassword() {
  router.push('/settings/account/change-password')
}

function goToAccountSettings() {
  router.push('/settings/account?setup2fa=true')
}

async function copyOrgId() {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return

  try {
    await navigator.clipboard.writeText(orgId)
    toast.success(t('copied-to-clipboard'))
  }
  catch (err) {
    console.error('Failed to copy:', err)
    toast.error(t('cannot-copy'))
  }
}
</script>

<template>
  <!-- Password Update Required Card -->
  <div v-if="needsPasswordUpdate" class="p-8 mx-auto mt-6 mb-6 max-w-2xl bg-[#FFFBEC] rounded-xl border border-orange-200">
    <div class="flex items-start">
      <div class="shrink-0">
        <svg class="w-8 h-8 text-[#FE9A02]" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd" />
        </svg>
      </div>
      <div class="flex-1 ml-4">
        <h3 class="text-lg font-semibold text-[#973C00]">
          {{ t('password-policy-required') }}
        </h3>
        <div class="mt-3 text-base text-[#BB4D00]">
          <p>{{ t('password-update-org-access') }}</p>
        </div>
        <div class="flex flex-wrap gap-3 mt-6">
          <button
            type="button"
            class="py-3 px-8 text-base font-semibold text-white bg-orange-500 rounded-lg shadow-md transition-colors duration-200 hover:bg-orange-600 hover:shadow-lg focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:outline-none"
            @click="goToChangePassword"
          >
            {{ t('update-password-now') }}
          </button>
          <button
            type="button"
            v-if="showCopyOrgId"
            class="py-3 px-8 text-base font-semibold text-[#973C00] bg-transparent border border-[#973C00] rounded-lg transition-colors duration-200 hover:bg-orange-100 focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:outline-none"
            @click="copyOrgId"
          >
            {{ t('copy-organization-id') }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 2FA Setup Required Card -->
  <div v-else-if="needs2FASetup" class="p-8 mx-auto mt-6 mb-6 max-w-2xl bg-[#FFFBEC] rounded-xl border border-orange-200">
    <div class="flex items-start">
      <div class="shrink-0">
        <svg class="w-8 h-8 text-[#FE9A02]" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
        </svg>
      </div>
      <div class="flex-1 ml-4">
        <h3 class="text-lg font-semibold text-[#973C00]">
          {{ t('2fa-setup-required') }}
        </h3>
        <div class="mt-3 text-base text-[#BB4D00]">
          <p>{{ t('2fa-setup-org-access') }}</p>
        </div>
        <div class="flex flex-wrap gap-3 mt-6">
          <button
            type="button"
            class="py-3 px-8 text-base font-semibold text-white bg-orange-500 rounded-lg shadow-md transition-colors duration-200 hover:bg-orange-600 hover:shadow-lg focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:outline-none"
            @click="goToAccountSettings"
          >
            {{ t('setup-2fa-now') }}
          </button>
          <button
            type="button"
            v-if="showCopyOrgId"
            class="py-3 px-8 text-base font-semibold text-[#973C00] bg-transparent border border-[#973C00] rounded-lg transition-colors duration-200 hover:bg-orange-100 focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:outline-none"
            @click="copyOrgId"
          >
            {{ t('copy-organization-id') }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Error Alert for Non-paying Users (only show if no password issue or 2FA issue) -->
  <div v-else-if="organizationStore.currentOrganizationFailed" class="p-8 mx-auto mt-6 mb-6 max-w-2xl bg-red-50 rounded-xl border border-red-200">
    <div class="flex items-start">
      <div class="shrink-0">
        <svg class="w-8 h-8 text-red-400" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
        </svg>
      </div>
      <div class="flex-1 ml-4">
        <h3 class="text-lg font-semibold text-red-800">
          {{ t('subscription-required') }}
        </h3>
        <div class="mt-3 text-base text-red-700">
          <p>{{ t(hideExternalPurchaseFlows ? 'plan-failed-native-description' : 'plan-failed-description') }}</p>
        </div>
        <div v-if="!hideExternalPurchaseFlows" class="mt-6">
          <button
            type="button"
            class="py-3 px-8 text-base font-semibold text-white bg-red-600 rounded-lg shadow-md transition-colors duration-200 hover:bg-red-700 hover:shadow-lg focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:outline-none"
            @click="goToPlans"
          >
            {{ t('plan-upgrade-v2') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
