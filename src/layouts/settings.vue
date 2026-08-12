<script setup lang="ts">
import type { Ref } from 'vue'
import type { Tab } from '~/components/comp_def'
import { computedAsync } from '@vueuse/core'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconBilling from '~icons/mingcute/bill-fill'
import FailedCard from '~/components/FailedCard.vue'
import RbacPermissionOnlyModal from '~/components/RbacPermissionOnlyModal.vue'
import Tabs from '~/components/Tabs.vue'
import { accountTabs } from '~/constants/accountTabs'
import { organizationTabs as baseOrgTabs } from '~/constants/organizationTabs'
import { settingsTabs } from '~/constants/settingsTabs'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { openPortal } from '~/services/stripe'
import { stripeEnabled } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'
import {
  BILLING_TAB_KEY,
  cloneTabs,
  defaultChild,
  findActiveChildKey,
  findActiveTabKey,
  pathMatchesTab,
  TEAM_TAB_KEY,
} from '~/utils/organizationTabs'

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const router = useRouter()
const route = useRoute()
const hideExternalPurchaseFlows = isNativeAppStoreContext()

const restrictedPurchaseKeys = new Set([
  '/billing',
  '/settings/organization/credits',
  '/settings/organization/plans',
])

// Modal state for non-admin billing access (triggered by billing tab click)
const showBillingModal = ref(false)

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

function withoutRestrictedPurchaseTabs(tabs: Tab[]): Tab[] {
  if (!hideExternalPurchaseFlows)
    return tabs

  return tabs
    .map((tab) => {
      if (!tab.children?.length)
        return restrictedPurchaseKeys.has(tab.key) ? null : tab
      const children = tab.children.filter(child => !restrictedPurchaseKeys.has(child.key))
      if (!children.length)
        return null
      return { ...tab, children }
    })
    .filter((tab): tab is Tab => tab !== null)
}

const organizationTabs = ref<Tab[]>(withoutRestrictedPurchaseTabs(cloneTabs(baseOrgTabs))) as Ref<Tab[]>

const canReadBilling = computedAsync(async () => {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.read_billing', { orgId })
}, false)

const canUpdateBilling = computedAsync(async () => {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.update_billing', { orgId })
}, false)

const auditLogsAccessEvaluating = ref(false)
const canReadAuditLogs = computedAsync(async () => {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.read_audit', { orgId })
}, false, { evaluating: auditLogsAccessEvaluating })

const securityAccessEvaluating = ref(false)
const canManageSecurity = computedAsync(async () => {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.update_settings', { orgId })
}, false, { evaluating: securityAccessEvaluating })

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
      '/settings/organization/credits',
      '/settings/organization/plans',
      '/billing',
    ]
    if (billingPaths.some(p => path === p || path.startsWith(`${p}/`)))
      router.replace(hideExternalPurchaseFlows ? '/settings/organization/usage' : '/settings/organization')
  }
})

watchEffect(() => {
  const billingEnabled = stripeEnabled.value
  const tabs = withoutRestrictedPurchaseTabs(cloneTabs(baseOrgTabs))

  const teamTab = tabs.find(tab => tab.key === TEAM_TAB_KEY)
  if (teamTab?.children) {
    if (!organizationStore.currentOrganization?.gid)
      teamTab.children = teamTab.children.filter(child => child.key !== '/settings/organization/groups')
    if (!canManageSecurity.value)
      teamTab.children = teamTab.children.filter(child => child.key !== '/settings/organization/security')
  }

  const billingTab = tabs.find(tab => tab.key === BILLING_TAB_KEY)
  const needsBillingGroup = billingEnabled && canReadBilling.value
  if (!needsBillingGroup) {
    const billingIndex = tabs.findIndex(tab => tab.key === BILLING_TAB_KEY)
    if (billingIndex >= 0)
      tabs.splice(billingIndex, 1)
  }
  else if (billingTab && !hideExternalPurchaseFlows) {
    billingTab.children = [
      ...(billingTab.children ?? []),
      {
        label: 'billing',
        icon: IconBilling,
        key: '/billing',
        onClick: () => {
          if (canUpdateBilling.value)
            openPortal(organizationStore.currentOrganization?.gid ?? '', t)
          else
            showBillingModal.value = true
        },
      },
    ]
  }

  const needsUsage = billingEnabled && canReadBilling.value
  if (!needsUsage) {
    const usageIndex = tabs.findIndex(tab => tab.key === '/settings/organization/usage')
    if (usageIndex >= 0)
      tabs.splice(usageIndex, 1)
  }

  if (!canReadAuditLogs.value) {
    const auditIndex = tabs.findIndex(tab => tab.key === '/settings/organization/auditlogs')
    if (auditIndex >= 0)
      tabs.splice(auditIndex, 1)
  }

  organizationTabs.value = tabs.filter(tab => !tab.children || tab.children.length > 0)
})

const activePrimary = computed(() => {
  const path = route.path
  if (path.startsWith('/settings/organization') || path === '/billing' || path.startsWith('/billing/'))
    return '/settings/organization'
  return '/settings/account'
})

const secondaryTabs = computed(() => {
  return activePrimary.value === '/settings/organization' ? organizationTabs.value : accountTabs
})

const activeSecondary = computed(() => {
  return findActiveTabKey(secondaryTabs.value, route.path) ?? secondaryTabs.value[0]?.key
})

const activeSecondaryTab = computed(() => {
  return secondaryTabs.value.find(tab => tab.key === activeSecondary.value)
})

const tertiaryTabs = computed(() => {
  const children = activeSecondaryTab.value?.children ?? []
  return children.length > 1 ? children : []
})

const activeTertiary = computed(() => {
  return findActiveChildKey(activeSecondaryTab.value, route.path)
})

function activateTab(tab: Tab | undefined) {
  if (!tab)
    return
  if (tab.onClick) {
    tab.onClick(tab.key)
    return
  }
  router.push(tab.key)
}

function handlePrimary(val: string) {
  // Clicking primary switches to the root of that section
  router.push(val === '/settings/organization' ? '/settings/organization' : '/settings/account')
}

function handleSecondary(val: string) {
  const tab = secondaryTabs.value.find(t => t.key === val)
  if (!tab)
    return
  if (tab.children?.length) {
    if (pathMatchesTab(tab, route.path))
      return
    activateTab(defaultChild(tab))
    return
  }
  activateTab(tab)
}

function handleTertiary(val: string) {
  const tab = tertiaryTabs.value.find(t => t.key === val)
  activateTab(tab)
}
</script>

<template>
  <div class="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
    <Tabs
      :tabs="settingsTabs"
      :active-tab="activePrimary"
      :secondary-tabs="shouldBlockContent ? [] : secondaryTabs"
      :secondary-active-tab="activeSecondary"
      :tertiary-tabs="shouldBlockContent ? [] : tertiaryTabs"
      :tertiary-active-tab="activeTertiary"
      no-wrap
      @update:active-tab="handlePrimary"
      @update:secondary-active-tab="handleSecondary"
      @update:tertiary-active-tab="handleTertiary"
    />
    <main class="flex relative flex-1 w-full min-h-0 mt-0 overflow-hidden bg-blue-50 dark:bg-slate-800/40">
      <div
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
      <!-- Permission modal for the billing tab click -->
      <RbacPermissionOnlyModal
        v-if="showBillingModal"
        :title="t('billing-access-required')"
        permission="org.update_billing"
        @close="showBillingModal = false"
      />
    </main>
  </div>
</template>
