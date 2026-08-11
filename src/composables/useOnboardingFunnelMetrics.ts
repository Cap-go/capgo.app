import type { ComputedRef, Ref } from 'vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export interface OnboardingFunnelMetricsData {
  total_registrations?: number
  total_orgs?: number
  orgs_with_app?: number
  orgs_with_channel?: number
  orgs_with_bundle?: number
  orgs_subscribed?: number
  orgs_with_production_device?: number
  orgs_with_update_download?: number
  activation_telemetry_available?: boolean
}

export function useOnboardingFunnelMetrics(
  onboardingFunnelData: Ref<OnboardingFunnelMetricsData | null>,
) {
  const { t } = useI18n()

  const onboardingFunnelRates = computed(() => {
    if (!onboardingFunnelData.value) {
      return {
        org: 0,
        app: 0,
        channel: 0,
        bundle: 0,
        subscribed: 0,
        productionDevice: 0,
        updateDownload: 0,
      }
    }

    const totalRegistrations = Number(onboardingFunnelData.value.total_registrations) || 0
    const totalOrgs = Number(onboardingFunnelData.value.total_orgs) || 0
    const orgsWithApp = Number(onboardingFunnelData.value.orgs_with_app) || 0
    const orgsWithChannel = Number(onboardingFunnelData.value.orgs_with_channel) || 0
    const orgsWithBundle = Number(onboardingFunnelData.value.orgs_with_bundle) || 0
    const orgsSubscribed = Number(onboardingFunnelData.value.orgs_subscribed) || 0
    const orgsWithProductionDevice = Number(onboardingFunnelData.value.orgs_with_production_device) || 0
    const orgsWithUpdateDownload = Number(onboardingFunnelData.value.orgs_with_update_download) || 0

    return {
      org: totalRegistrations > 0 ? (totalOrgs / totalRegistrations) * 100 : 0,
      app: totalOrgs > 0 ? (orgsWithApp / totalOrgs) * 100 : 0,
      channel: orgsWithApp > 0 ? (orgsWithChannel / orgsWithApp) * 100 : 0,
      bundle: orgsWithChannel > 0 ? (orgsWithBundle / orgsWithChannel) * 100 : 0,
      subscribed: orgsWithBundle > 0 ? (orgsSubscribed / orgsWithBundle) * 100 : 0,
      productionDevice: orgsWithBundle > 0 ? (orgsWithProductionDevice / orgsWithBundle) * 100 : 0,
      updateDownload: orgsWithProductionDevice > 0 ? (orgsWithUpdateDownload / orgsWithProductionDevice) * 100 : 0,
    }
  })

  const onboardingFunnelConversionSummaries = computed(() => {
    const rates = onboardingFunnelRates.value
    const items = [
      {
        key: 'org',
        value: rates.org,
        label: t('register-to-org'),
        colorClass: 'text-sky-500',
      },
      {
        key: 'app',
        value: rates.app,
        label: t('org-to-app'),
        colorClass: 'text-purple-500',
      },
      {
        key: 'channel',
        value: rates.channel,
        label: t('app-to-channel'),
        colorClass: 'text-amber-500',
      },
      {
        key: 'bundle',
        value: rates.bundle,
        label: t('channel-to-bundle'),
        colorClass: 'text-emerald-500',
      },
    ]

    if (onboardingFunnelData.value?.activation_telemetry_available) {
      items.push(
        {
          key: 'productionDevice',
          value: rates.productionDevice,
          label: t('bundle-to-production-device'),
          colorClass: 'text-pink-500',
        },
        {
          key: 'updateDownload',
          value: rates.updateDownload,
          label: t('production-device-to-update-download'),
          colorClass: 'text-indigo-500',
        },
      )
    }

    items.push({
      key: 'subscribed',
      value: rates.subscribed,
      label: t('bundle-to-subscribed'),
      colorClass: 'text-rose-500',
    })

    return items
  })

  const onboardingFunnelConversionGridClass: ComputedRef<string> = computed(() => {
    // Keep one row on large screens so rates follow the funnel columns.
    const count = onboardingFunnelConversionSummaries.value.length
    if (count >= 7)
      return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-7'
    if (count >= 6)
      return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
    if (count >= 5)
      return 'grid-cols-2 sm:grid-cols-5'
    return 'grid-cols-2 sm:grid-cols-4'
  })

  return {
    onboardingFunnelRates,
    onboardingFunnelConversionSummaries,
    onboardingFunnelConversionGridClass,
  }
}
