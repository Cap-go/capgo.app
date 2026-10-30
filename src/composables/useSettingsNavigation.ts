import type { Ref } from 'vue'
import type { Tab } from '~/components/comp_def'
import { computedAsync } from '@vueuse/core'
import { computed, ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import IconBilling from '~icons/mingcute/bill-fill'
import { accountTabs } from '~/constants/accountTabs'
import { organizationTabs as baseOrgTabs } from '~/constants/organizationTabs'
import { stripeEnabled } from '~/services/console'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { useOrganizationStore } from '~/stores/organization'
import { BILLING_TAB_KEY, cloneTabs, findActiveTabKey, TEAM_TAB_KEY } from '~/utils/organizationTabs'

export type SettingsSection = 'account' | 'organization'

export function settingsSectionForPath(path: string): SettingsSection | null {
  if (path.startsWith('/settings/organization') || path === '/billing' || path.startsWith('/billing/'))
    return 'organization'
  if (path.startsWith('/settings/account'))
    return 'account'
  return null
}

const restrictedPurchaseKeys = new Set([
  '/billing',
  '/settings/organization/billing',
  '/settings/organization/credits',
  '/settings/organization/plans',
])

function withoutRestrictedPurchaseTabs(tabs: Tab[], hide: boolean): Tab[] {
  if (!hide)
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

/**
 * Settings destinations for the current route, filtered by the user's
 * permissions in the current organization. Shared by the settings sidebar and
 * the settings layout (mobile tab row and permission gates).
 */
export function useSettingsNavigation() {
  const route = useRoute()
  const organizationStore = useOrganizationStore()
  const hideExternalPurchaseFlows = isNativeAppStoreContext()

  const canReadBilling = computedAsync(async () => {
    const orgId = organizationStore.currentOrganization?.gid
    if (!orgId)
      return false
    return await checkPermissions('org.read_billing', { orgId })
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

  const organizationTabs = ref<Tab[]>(withoutRestrictedPurchaseTabs(cloneTabs(baseOrgTabs), hideExternalPurchaseFlows)) as Ref<Tab[]>

  watchEffect(() => {
    const billingEnabled = stripeEnabled.value
    const tabs = withoutRestrictedPurchaseTabs(cloneTabs(baseOrgTabs), hideExternalPurchaseFlows)

    const teamTab = tabs.find(tab => tab.key === TEAM_TAB_KEY)
    if (teamTab?.children) {
      if (!organizationStore.currentOrganization?.gid)
        teamTab.children = teamTab.children.filter(child => child.key !== '/settings/organization/groups')
      if (!canManageSecurity.value)
        teamTab.children = teamTab.children.filter(child => child.key !== '/settings/organization/security')
    }

    const billingTab = tabs.find(tab => tab.key === BILLING_TAB_KEY)
    const canSeeBilling = billingEnabled && canReadBilling.value
    if (!canSeeBilling) {
      const billingIndex = tabs.findIndex(tab => tab.key === BILLING_TAB_KEY)
      if (billingIndex >= 0)
        tabs.splice(billingIndex, 1)
      const usageIndex = tabs.findIndex(tab => tab.key === '/settings/organization/usage')
      if (usageIndex >= 0)
        tabs.splice(usageIndex, 1)
    }
    else if (billingTab && !hideExternalPurchaseFlows) {
      billingTab.children = [
        ...(billingTab.children ?? []),
        { label: 'billing-portal-tab', icon: IconBilling, key: '/settings/organization/billing' },
      ]
    }

    if (!canReadAuditLogs.value) {
      const auditIndex = tabs.findIndex(tab => tab.key === '/settings/organization/auditlogs')
      if (auditIndex >= 0)
        tabs.splice(auditIndex, 1)
    }

    organizationTabs.value = tabs.filter(tab => !tab.children || tab.children.length > 0)
  })

  const section = computed(() => settingsSectionForPath(route.path))

  // Grouped tabs: a tab with children is a titled group, plain tabs are top level.
  const tabs = computed(() => section.value === 'organization' ? organizationTabs.value : accountTabs)
  const flatTabs = computed(() => tabs.value.flatMap(tab => tab.children?.length ? tab.children : [tab]))
  const activeKey = computed(() => findActiveTabKey(flatTabs.value, route.path))

  return {
    section,
    tabs,
    flatTabs,
    activeKey,
    canManageSecurity,
    securityAccessEvaluating,
    canReadAuditLogs,
    auditLogsAccessEvaluating,
  }
}
