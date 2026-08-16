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
import {
  organizationMainTabs as baseOrgMainTabs,
  organizationPlanSubTabs as basePlanSubTabs,
  organizationTeamSubTabs as baseTeamSubTabs,
  isOrgPlanPath,
  isOrgTeamPath,
  ORG_PLAN_HUB,
  ORG_TEAM_HUB,
} from '~/constants/organizationTabs'
import { settingsTabs } from '~/constants/settingsTabs'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { openPortal } from '~/services/stripe'
import { stripeEnabled } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const router = useRouter()
const route = useRoute()
const hideExternalPurchaseFlows = isNativeAppStoreContext()

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

// keep Tab icon typing (including ShallowRef) instead of Vue's UnwrapRef narrowing
function withoutExternalPurchaseTabs(tabs: Tab[]) {
  if (!hideExternalPurchaseFlows)
    return tabs

  const restrictedKeys = new Set([
    '/billing',
    '/settings/organization/credits',
    '/settings/organization/plans',
    ORG_PLAN_HUB,
  ])
  return tabs.filter(tab => !restrictedKeys.has(tab.key))
}

const organizationTabs = ref<Tab[]>(withoutExternalPurchaseTabs([...baseOrgMainTabs])) as Ref<Tab[]>
const teamSubTabs = ref<Tab[]>([...baseTeamSubTabs]) as Ref<Tab[]>
const planSubTabs = ref<Tab[]>(withoutExternalPurchaseTabs([...basePlanSubTabs])) as Ref<Tab[]>

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

function sortByBase(tabs: Tab[], base: Tab[]) {
  tabs.sort((a, b) => {
    const idxA = base.findIndex(t => t.key === a.key)
    const idxB = base.findIndex(t => t.key === b.key)
    if (idxA === -1 && idxB === -1)
      return 0
    if (idxA === -1)
      return 1
    if (idxB === -1)
      return -1
    return idxA - idxB
  })
}

function upsertTab(tabs: Ref<Tab[]>, key: string, base: Tab[]) {
  if (tabs.value.find(tab => tab.key === key))
    return
  const found = base.find(t => t.key === key)
  if (found)
    tabs.value.push({ ...found })
}

function removeTab(tabs: Ref<Tab[]>, key: string) {
  if (!tabs.value.find(tab => tab.key === key))
    return
  tabs.value = tabs.value.filter(tab => tab.key !== key)
}

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
  const needsGroups = !!organizationStore.currentOrganization?.gid
  const needsUsage = billingEnabled && canReadBilling.value
  // Plans/Credits/Billing are visible with org.read_billing; mutations stay gated by org.update_billing.
  const needsPlanPages = billingEnabled && canReadBilling.value && !hideExternalPurchaseFlows
  const needsAuditLogs = canReadAuditLogs.value
  const needsSecurity = canManageSecurity.value

  // --- Secondary (main) org tabs ---
  upsertTab(organizationTabs, ORG_TEAM_HUB, baseOrgMainTabs)

  if (needsPlanPages)
    upsertTab(organizationTabs, ORG_PLAN_HUB, baseOrgMainTabs)
  else
    removeTab(organizationTabs, ORG_PLAN_HUB)

  if (needsUsage)
    upsertTab(organizationTabs, '/settings/organization/usage', baseOrgMainTabs)
  else
    removeTab(organizationTabs, '/settings/organization/usage')

  if (needsAuditLogs)
    upsertTab(organizationTabs, '/settings/organization/auditlogs', baseOrgMainTabs)
  else
    removeTab(organizationTabs, '/settings/organization/auditlogs')

  sortByBase(organizationTabs.value, baseOrgMainTabs)

  // --- Team sub-tabs ---
  if (needsGroups)
    upsertTab(teamSubTabs, '/settings/organization/groups', baseTeamSubTabs)
  else
    removeTab(teamSubTabs, '/settings/organization/groups')

  if (needsSecurity)
    upsertTab(teamSubTabs, '/settings/organization/security', baseTeamSubTabs)
  else
    removeTab(teamSubTabs, '/settings/organization/security')

  // Members is always present in the team hub
  upsertTab(teamSubTabs, '/settings/organization/members', baseTeamSubTabs)
  sortByBase(teamSubTabs.value, baseTeamSubTabs)

  // --- Plan sub-tabs ---
  if (needsPlanPages) {
    upsertTab(planSubTabs, '/settings/organization/plans', basePlanSubTabs)
    upsertTab(planSubTabs, '/settings/organization/credits', basePlanSubTabs)
  }
  else {
    removeTab(planSubTabs, '/settings/organization/plans')
    removeTab(planSubTabs, '/settings/organization/credits')
  }

  // Billing portal entry: users with org.read_billing can see it; update opens Stripe
  const billingTabKey = '/billing'
  const openBilling = () => {
    if (canUpdateBilling.value) {
      openPortal(organizationStore.currentOrganization?.gid ?? '', t)
    }
    else {
      showBillingModal.value = true
    }
  }
  const hasBilling = planSubTabs.value.find(tab => tab.key === billingTabKey)
  if (needsPlanPages) {
    if (!hasBilling) {
      planSubTabs.value.push({
        label: 'billing',
        icon: IconBilling,
        key: billingTabKey,
        onClick: openBilling,
      })
    }
  }
  else if (hasBilling) {
    removeTab(planSubTabs, billingTabKey)
  }

  sortByBase(planSubTabs.value, [...basePlanSubTabs, { label: 'billing', key: billingTabKey, icon: IconBilling }])

  // Drop plan hub entirely when no plan sub-tabs remain
  if (planSubTabs.value.length === 0)
    removeTab(organizationTabs, ORG_PLAN_HUB)
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
  const tabs = secondaryTabs.value
  const path = route.path.replace(/\/$/, '')

  if (activePrimary.value === '/settings/organization') {
    if (isOrgTeamPath(path))
      return ORG_TEAM_HUB
    if (isOrgPlanPath(path))
      return ORG_PLAN_HUB
  }

  // Prefer the most specific match (longest path) so nested routes like
  // `/settings/organization/members` don't get claimed by the parent
  // `/settings/organization` tab.
  const ordered = [...tabs].sort((a, b) => b.key.length - a.key.length)

  const match = ordered.find((t) => {
    const key = t.key.replace(/\/$/, '')
    return path === key || path.startsWith(`${key}/`)
  })

  return match?.key ?? tabs[0]?.key
})

const tertiaryTabs = computed(() => {
  if (shouldBlockContent.value || activePrimary.value !== '/settings/organization')
    return []
  const path = route.path.replace(/\/$/, '')
  if (isOrgTeamPath(path))
    return teamSubTabs.value
  if (isOrgPlanPath(path))
    return planSubTabs.value
  return []
})

const activeTertiary = computed(() => {
  const tabs = tertiaryTabs.value
  if (!tabs.length)
    return undefined
  const path = route.path.replace(/\/$/, '')

  const ordered = [...tabs].sort((a, b) => b.key.length - a.key.length)
  const match = ordered.find((t) => {
    const key = t.key.replace(/\/$/, '')
    return path === key || path.startsWith(`${key}/`)
  })

  // Billing is an action tab without a route match while staying under Plan hub
  if (!match && isOrgPlanPath(path) && path === '/billing')
    return '/billing'

  return match?.key ?? tabs[0]?.key
})

function handlePrimary(val: string) {
  // Clicking primary switches to the root of that section
  router.push(val === '/settings/organization' ? '/settings/organization' : '/settings/account')
}
function handleSecondary(val: string) {
  const tab = secondaryTabs.value.find(t => t.key === val)
  if (tab?.onClick) {
    tab.onClick(val)
    return
  }
  router.push(val)
}
function handleTertiary(val: string) {
  const tab = tertiaryTabs.value.find(t => t.key === val)
  if (tab?.onClick) {
    tab.onClick(val)
    return
  }
  router.push(val)
}
</script>

<template>
  <div class="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
    <Tabs
      :tabs="settingsTabs"
      :active-tab="activePrimary"
      :secondary-tabs="shouldBlockContent ? [] : secondaryTabs"
      :secondary-active-tab="activeSecondary"
      :tertiary-tabs="tertiaryTabs"
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
