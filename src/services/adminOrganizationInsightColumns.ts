import type { TableColumn } from '~/components/comp_def'
import type { OrganizationInsight } from '~/services/adminOrganizationInsights'
import { h } from 'vue'
import {
  formatOrganizationBillingTypeLabel,
  formatOrganizationDateOrNever,
  formatOrganizationNumber,
} from '~/services/adminOrganizationInsights'
import { formatLocalDate } from '~/services/date'

/** Shared organization-insight columns used by customers + retention inactive views. */
export function createSharedOrganizationInsightColumns(
  t: (key: string) => string,
): TableColumn[] {
  return [
    {
      label: t('org-name'),
      key: 'org_name',
      mobile: true,
      head: true,
      sortable: false,
      renderFunction: (item: OrganizationInsight) => {
        return h('div', { class: 'min-w-0' }, [
          h('p', { class: 'truncate font-medium text-slate-900 dark:text-white' }, item.org_name),
          h('p', { class: 'truncate text-xs font-normal text-slate-500 dark:text-slate-400' }, item.management_email),
        ])
      },
    },
    {
      label: t('plan'),
      key: 'plan_name',
      mobile: true,
      sortable: false,
      displayFunction: (item: OrganizationInsight) => item.plan_name || t('unknown'),
    },
    {
      label: t('billing-cycle'),
      key: 'billing_type',
      mobile: false,
      sortable: false,
      displayFunction: (item: OrganizationInsight) => formatOrganizationBillingTypeLabel(item.billing_type, t),
    },
    {
      label: t('total-mau-period'),
      key: 'mau',
      mobile: true,
      sortable: false,
      class: 'text-right',
      displayFunction: (item: OrganizationInsight) => formatOrganizationNumber(item.mau),
    },
    {
      label: t('uploads-period'),
      key: 'upload_count',
      mobile: false,
      sortable: false,
      class: 'text-right',
      displayFunction: (item: OrganizationInsight) => formatOrganizationNumber(item.upload_count),
    },
    {
      label: t('last-upload'),
      key: 'last_upload_at',
      mobile: false,
      sortable: false,
      displayFunction: (item: OrganizationInsight) => formatOrganizationDateOrNever(item.last_upload_at, t),
    },
    {
      label: t('paid-at'),
      key: 'paid_at',
      mobile: false,
      sortable: false,
      displayFunction: (item: OrganizationInsight) => formatLocalDate(item.paid_at) || t('never'),
    },
    {
      label: t('registered-at'),
      key: 'registered_at',
      mobile: false,
      sortable: false,
      displayFunction: (item: OrganizationInsight) => formatLocalDate(item.registered_at) || t('unknown'),
    },
    {
      label: t('members'),
      key: 'members_count',
      mobile: false,
      sortable: false,
      class: 'text-right',
      displayFunction: (item: OrganizationInsight) => formatOrganizationNumber(item.members_count),
    },
  ]
}
