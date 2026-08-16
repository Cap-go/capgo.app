<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const router = useRouter()
const organizationStore = useOrganizationStore()

// Show banner if user doesn't have password policy access
const showBanner = computed(() => {
  const org = organizationStore.currentOrganization
  // Show banner if org has password policy enabled and user doesn't have access
  return org?.password_policy_config?.enabled && org?.password_has_access === false
})

function goToChangePassword() {
  router.push('/settings/account/change-password')
}
</script>

<template>
  <div v-if="showBanner" class="sticky top-0 z-50 px-4 py-3 text-center text-white bg-red-500">
    <div class="flex flex-col items-center justify-center gap-2 md:flex-row">
      <div>
        <p class="font-semibold">
          {{ t('password-policy-required') }}
        </p>
        <p class="text-sm opacity-90">
          {{ t('password-policy-required-message') }}
        </p>
      </div>
      <button
        type="button"
        class="px-4 py-1 ml-4 text-sm font-medium text-red-500 bg-white rounded-lg hover:bg-gray-100"
        @click="goToChangePassword"
      >
        {{ t('update-password-now') }}
      </button>
    </div>
  </div>
</template>
