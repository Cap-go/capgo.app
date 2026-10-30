<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import FailedCard from '~/components/FailedCard.vue'
import RbacPermissionOnlyModal from '~/components/RbacPermissionOnlyModal.vue'
import Tabs from '~/components/Tabs.vue'
import { useSettingsNavigation } from '~/composables/useSettingsNavigation'
import { stripeEnabled } from '~/services/console'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const router = useRouter()
const route = useRoute()
const hideExternalPurchaseFlows = isNativeAppStoreContext()
const {
  flatTabs,
  activeKey,
  canManageSecurity,
  securityAccessEvaluating,
  canReadAuditLogs,
  auditLogsAccessEvaluating,
} = useSettingsNavigation()

// Check if user needs to setup 2FA or update password for organization access
const needsSecurityCompliance = computed(() => {
  const org = organizationStore.currentOrganization
  const needs2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const needsPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return needs2FA || needsPassword
})

// Only block organization settings, not account settings (user needs access to account to fix the issue)
const shouldBlockContent = computed(() => {
  return needsSecurityCompliance.value && route.path.startsWith('/settings/organization')
})

// Security-sensitive org routes are gated by their own RBAC permission. When the
// current user lacks it (e.g. reached the route via a direct link), show a modal
// explaining what access is needed and who can grant it.
const adminOnlyRouteGate = computed(() => {
  const path = route.path.replace(/\/$/, '')
  if (path === '/settings/organization/security') {
    return { permission: 'org.update_settings' as const, title: t('security-access-required'), hasAccess: canManageSecurity.value, evaluating: securityAccessEvaluating.value }
  }
  if (path === '/settings/organization/audit-logs' || path === '/settings/organization/auditlogs') {
    return { permission: 'org.read_audit' as const, title: t('audit-access-required'), hasAccess: canReadAuditLogs.value, evaluating: auditLogsAccessEvaluating.value }
  }
  return null
})

// Don't flash the modal while the permission check is still resolving.
const showAdminOnlyModal = computed(() => {
  const gate = adminOnlyRouteGate.value
  return !!gate && !gate.evaluating && !gate.hasAccess
})

watchEffect(() => {
  if (!stripeEnabled.value || hideExternalPurchaseFlows) {
    const path = route.path.replace(/\/$/, '')
    const billingPaths = [
      ...(hideExternalPurchaseFlows ? [] : ['/settings/organization/usage']),
      '/settings/organization/billing',
      '/settings/organization/credits',
      '/settings/organization/plans',
      '/billing',
    ]
    if (billingPaths.some(p => path === p || path.startsWith(`${p}/`)))
      router.replace(hideExternalPurchaseFlows ? '/settings/organization/usage' : '/settings/organization')
  }
})

function openTab(key: string) {
  const tab = flatTabs.value.find(item => item.key === key)
  if (tab?.onClick)
    tab.onClick(tab.key)
  else if (tab)
    router.push(tab.key)
}
</script>

<template>
  <div class="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
    <!-- Desktop uses the settings sidebar; small screens and the native app keep a tab row. -->
    <Tabs
      class="lg:hidden"
      :tabs="shouldBlockContent ? [] : flatTabs"
      :active-tab="activeKey ?? ''"
      no-wrap
      @update:active-tab="openTab"
    />
    <main class="flex relative flex-1 w-full min-h-0 mt-0 overflow-hidden bg-blue-50 dark:bg-slate-800/40">
      <div
        data-native-scroll
        class="flex-1 w-full min-h-0 px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-16 lg:px-8 max-w-9xl"
        :class="{ 'blur-sm pointer-events-none select-none': showAdminOnlyModal }"
      >
        <!-- Show FailedCard instead of normal content when security compliance is required -->
        <FailedCard v-if="shouldBlockContent" />
        <RouterView v-else class="w-full" />
      </div>
      <!-- Permission modal for security-sensitive org routes reached without access -->
      <RbacPermissionOnlyModal
        v-if="showAdminOnlyModal && adminOnlyRouteGate"
        :title="adminOnlyRouteGate.title"
        :permission="adminOnlyRouteGate.permission"
      />
    </main>
  </div>
</template>
