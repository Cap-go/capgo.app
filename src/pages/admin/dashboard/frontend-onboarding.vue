<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { AdminOnboardingJourneyGraphConfig, AdminOnboardingJourneyNode } from '~/components/admin/adminOnboardingJourneyGraph'
import type {
  FrontendOnboardingAnalytics,
  FrontendOnboardingDailySetupCliOutcomeKey,
  FrontendOnboardingStageKey,
} from '~/services/adminFrontendOnboarding'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminBarChart from '~/components/admin/AdminBarChart.vue'
import AdminChartDeduplicateControl from '~/components/admin/AdminChartDeduplicateControl.vue'
import AdminDailyConversionChart from '~/components/admin/AdminDailyConversionChart.vue'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminFunnelChart from '~/components/admin/AdminFunnelChart.vue'
import AdminOnboardingJourneyGraph from '~/components/admin/AdminOnboardingJourneyGraph.vue'
import AdminStackedBarChart from '~/components/admin/AdminStackedBarChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingDailySetupCliSeries,
  buildFrontendOnboardingDailyWelcomeOutcomeSeries,
  buildFrontendOnboardingFunnelStages,
  buildFrontendOnboardingFunnelSummaries,
  buildFrontendOnboardingGraphMetrics,
  createFrontendOnboardingAnalyticsLoader,
  formatFrontendOnboardingDuration,
} from '~/services/adminFrontendOnboarding'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const adminStore = useAdminDashboardStore()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const isLoading = ref(true)
const isLoadingStats = ref(false)
const isReady = ref(false)
const analytics = ref<FrontendOnboardingAnalytics | null>(null)
const loadError = ref(false)
const deduplicateDailyAttempts = ref(false)
const deduplicateV4Funnel = ref(false)
const deduplicateWelcomeOutcomes = ref(false)

const v4DetailsGraphDefinitions = [
  { key: 'onboarding_app_name_entered' },
  { key: 'onboarding_app_id_entered' },
  { key: 'onboarding_app_id_help_opened' },
  { key: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_import_hidden', parentKey: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_url_entered', parentKey: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_import_submitted', parentKey: 'onboarding_store_url_entered' },
  { key: 'onboarding_store_import_succeeded', parentKey: 'onboarding_store_import_submitted' },
  { key: 'onboarding_store_import_failed', parentKey: 'onboarding_store_import_submitted' },
  { key: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picker_open_failed', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picker_closed_without_selection', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picked', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_uploaded', parentKey: 'onboarding_app_icon_picked' },
  { key: 'onboarding_app_icon_upload_failed', parentKey: 'onboarding_app_icon_picked' },
] as const

const v4OrganizationGraphDefinitions = [
  { key: 'onboarding_organization_import_opened' },
  { key: 'onboarding_organization_import_submitted', parentKey: 'onboarding_organization_import_opened' },
  { key: 'onboarding_organization_import_succeeded', parentKey: 'onboarding_organization_import_submitted' },
  { key: 'onboarding_organization_import_failed', parentKey: 'onboarding_organization_import_submitted' },
  { key: 'onboarding_organization_invite_viewed' },
  { key: 'onboarding_organization_invite_opened', parentKey: 'onboarding_organization_invite_viewed' },
  { key: 'onboarding_organization_invite_succeeded', parentKey: 'onboarding_organization_invite_opened' },
  { key: 'onboarding_organization_invite_continued', parentKey: 'onboarding_organization_invite_viewed' },
  { key: 'onboarding_app_creation_started' },
  { key: 'onboarding_app_creation_succeeded', parentKey: 'onboarding_app_creation_started' },
  { key: 'onboarding_app_creation_failed', parentKey: 'onboarding_app_creation_started' },
] as const

const v4SetupGraphDefinitions = [
  { key: 'onboarding_technical_invite_opened' },
  { key: 'onboarding_technical_invite_succeeded', parentKey: 'onboarding_technical_invite_opened' },
] as const

const v4DetailsGraphEventNodes = [
  { id: 'app_name', eventKey: 'onboarding_app_name_entered', labelKey: 'frontend-onboarding-graph-app-name-entered', x: 820, y: 90, icon: 'app' },
  { id: 'app_id', eventKey: 'onboarding_app_id_entered', labelKey: 'frontend-onboarding-graph-app-id-entered', x: 820, y: 195, icon: 'file' },
  { id: 'learn_more', eventKey: 'onboarding_app_id_help_opened', labelKey: 'frontend-onboarding-graph-app-id-help-opened', x: 820, y: 300, icon: 'details' },
  { id: 'store_opened', eventKey: 'onboarding_store_import_shown', labelKey: 'frontend-onboarding-graph-store-import-opened', x: 820, y: 455, icon: 'import' },
  { id: 'import_closed', eventKey: 'onboarding_store_import_hidden', labelKey: 'frontend-onboarding-graph-import-closed', x: 1180, y: 405, icon: 'close', tone: 'muted' },
  { id: 'store_url', eventKey: 'onboarding_store_url_entered', labelKey: 'frontend-onboarding-graph-store-url-entered', x: 1180, y: 505, icon: 'link' },
  { id: 'import_clicked', eventKey: 'onboarding_store_import_submitted', labelKey: 'frontend-onboarding-graph-import-clicked', x: 1540, y: 505, icon: 'import' },
  { id: 'import_succeeded', eventKey: 'onboarding_store_import_succeeded', labelKey: 'frontend-onboarding-graph-import-succeeded', x: 1880, y: 455, icon: 'success', tone: 'success' },
  { id: 'import_failed', eventKey: 'onboarding_store_import_failed', labelKey: 'frontend-onboarding-graph-import-failed', x: 1880, y: 555, icon: 'failure', tone: 'danger' },
  { id: 'picker_opened', eventKey: 'onboarding_app_icon_picker_opened', labelKey: 'frontend-onboarding-graph-file-picker-opened', x: 820, y: 720, icon: 'file' },
  { id: 'picker_failed', eventKey: 'onboarding_app_icon_picker_open_failed', labelKey: 'frontend-onboarding-graph-file-picker-failed', x: 1180, y: 620, icon: 'failure', tone: 'danger' },
  { id: 'picker_closed', eventKey: 'onboarding_app_icon_picker_closed_without_selection', labelKey: 'frontend-onboarding-graph-closed-without-selection', x: 1180, y: 720, icon: 'close', tone: 'muted' },
  { id: 'icon_picked', eventKey: 'onboarding_app_icon_picked', labelKey: 'frontend-onboarding-graph-app-icon-picked', x: 1180, y: 820, icon: 'icon' },
  { id: 'icon_uploaded', eventKey: 'onboarding_app_icon_uploaded', labelKey: 'frontend-onboarding-graph-app-icon-uploaded', x: 1540, y: 770, icon: 'upload', tone: 'success' },
  { id: 'icon_upload_failed', eventKey: 'onboarding_app_icon_upload_failed', labelKey: 'frontend-onboarding-graph-icon-upload-failed', x: 1540, y: 870, icon: 'upload', tone: 'danger' },
] as const

const v4OrganizationGraphEventNodes = [
  { id: 'organization_import_opened', eventKey: 'onboarding_organization_import_opened', labelKey: 'frontend-onboarding-graph-organization-import-opened', x: 2800, y: 160, icon: 'import' },
  { id: 'organization_import_submitted', eventKey: 'onboarding_organization_import_submitted', labelKey: 'frontend-onboarding-graph-organization-import-submitted', x: 3160, y: 160, icon: 'import' },
  { id: 'organization_import_succeeded', eventKey: 'onboarding_organization_import_succeeded', labelKey: 'frontend-onboarding-graph-organization-import-succeeded', x: 3520, y: 110, icon: 'success', tone: 'success' },
  { id: 'organization_import_failed', eventKey: 'onboarding_organization_import_failed', labelKey: 'frontend-onboarding-graph-organization-import-failed', x: 3520, y: 210, icon: 'failure', tone: 'danger' },
  { id: 'organization_invite_viewed', eventKey: 'onboarding_organization_invite_viewed', labelKey: 'frontend-onboarding-graph-organization-invite-viewed', x: 2800, y: 650, icon: 'organization' },
  { id: 'organization_invite_opened', eventKey: 'onboarding_organization_invite_opened', labelKey: 'frontend-onboarding-graph-organization-invite-opened', x: 3160, y: 570, icon: 'organization' },
  { id: 'organization_invite_succeeded', eventKey: 'onboarding_organization_invite_succeeded', labelKey: 'frontend-onboarding-graph-organization-invite-succeeded', x: 3520, y: 520, icon: 'success', tone: 'success' },
  { id: 'organization_invite_continued', eventKey: 'onboarding_organization_invite_continued', labelKey: 'frontend-onboarding-graph-organization-invite-continued', x: 3880, y: 700, icon: 'setup' },
  { id: 'app_creation_started', eventKey: 'onboarding_app_creation_started', labelKey: 'frontend-onboarding-graph-app-creation-started', x: 3160, y: 850, icon: 'app' },
  { id: 'app_creation_succeeded', eventKey: 'onboarding_app_creation_succeeded', labelKey: 'frontend-onboarding-graph-app-creation-succeeded', x: 3520, y: 800, icon: 'success', tone: 'success' },
  { id: 'app_creation_failed', eventKey: 'onboarding_app_creation_failed', labelKey: 'frontend-onboarding-graph-app-creation-failed', x: 3520, y: 900, icon: 'failure', tone: 'danger' },
] as const

const v4SetupGraphEventNodes = [
  { id: 'technical_invite_opened', eventKey: 'onboarding_technical_invite_opened', labelKey: 'frontend-onboarding-graph-technical-invite-opened', x: 4950, y: 450, icon: 'organization' },
  { id: 'technical_invite_succeeded', eventKey: 'onboarding_technical_invite_succeeded', labelKey: 'frontend-onboarding-graph-technical-invite-succeeded', x: 5300, y: 450, icon: 'success', tone: 'success' },
] as const

const loadAnalytics = createFrontendOnboardingAnalyticsLoader(
  async () => {
    const result = await adminStore.fetchStats('frontend_onboarding_analytics')
    if (result && (
      !Array.isArray(result.deduplicated?.daily_attempts)
      || (
        !Array.isArray(result.deduplicated?.funnels?.v4)
        && !Array.isArray(result.deduplicated?.funnels?.v3)
      )
    )) {
      throw new Error('Frontend onboarding analytics response is missing deduplicated chart data')
    }
    return result || null
  },
  {
    onAnalytics: (value) => {
      analytics.value = value
      loadError.value = false
    },
    onError: (error) => {
      loadError.value = true
      console.error('[Admin Frontend Onboarding] Error loading analytics:', error)
    },
    onLoading: (value) => {
      isLoadingStats.value = value
      if (value)
        loadError.value = false
      if (!value)
        isLoading.value = false
    },
  },
)

const visibleAnalytics = computed(() => isLoadingStats.value ? null : analytics.value)
const displayedDailyAttempts = computed(() => deduplicateDailyAttempts.value
  ? visibleAnalytics.value?.deduplicated.daily_attempts ?? []
  : visibleAnalytics.value?.daily_attempts ?? [])
const displayedWelcomeOutcomes = computed(() => deduplicateWelcomeOutcomes.value
  ? visibleAnalytics.value?.deduplicated.daily_welcome_outcomes ?? []
  : visibleAnalytics.value?.daily_welcome_outcomes ?? [])
const rawLatestFunnel = computed(() => {
  const funnels = visibleAnalytics.value?.funnels
  const v4 = funnels?.v4
  return {
    version: v4 === undefined ? 'v3' : 'v4',
    stages: v4 ?? funnels?.v3 ?? [],
  } as const
})
const displayedLatestFunnel = computed(() => {
  const funnels = deduplicateV4Funnel.value
    ? visibleAnalytics.value?.deduplicated.funnels
    : visibleAnalytics.value?.funnels
  const v4 = funnels?.v4
  return {
    version: v4 === undefined ? 'v3' : 'v4',
    stages: v4 ?? funnels?.v3 ?? [],
  } as const
})
const displayedV4Funnel = computed(() => displayedLatestFunnel.value.stages)
const latestVersionLabel = computed(() => t(rawLatestFunnel.value.version === 'v4'
  ? 'frontend-onboarding-version-4'
  : 'frontend-onboarding-version-3'))
const displayedFunnelTitle = computed(() => t(displayedLatestFunnel.value.version === 'v4'
  ? 'frontend-onboarding-funnel-v4'
  : 'frontend-onboarding-funnel-v3'))
const kpis = computed(() => rawLatestFunnel.value.version === 'v4'
  ? visibleAnalytics.value?.v4_kpis ?? visibleAnalytics.value?.kpis
  : visibleAnalytics.value?.kpis)
const dailySeries = computed(() => buildFrontendOnboardingDailySeries(
  displayedDailyAttempts.value,
  t('frontend-onboarding-version-1'),
  t('frontend-onboarding-version-2'),
  t('frontend-onboarding-version-3'),
  t('frontend-onboarding-version-4'),
))
const welcomeOutcomeSeries = computed(() => buildFrontendOnboardingDailyWelcomeOutcomeSeries(
  displayedWelcomeOutcomes.value,
  t('frontend-onboarding-welcome-advanced-to-intent'),
  t('frontend-onboarding-welcome-not-viewed'),
  t('frontend-onboarding-welcome-did-not-advance'),
))
const latestDailyConversions = computed(() => rawLatestFunnel.value.version === 'v4'
  ? visibleAnalytics.value?.v4_daily_conversions ?? visibleAnalytics.value?.daily_conversions
  : visibleAnalytics.value?.daily_conversions)
const intentToDetailsDaily = computed(() => latestDailyConversions.value?.intent_to_details ?? [])
const detailsToOrganizationDaily = computed(() => latestDailyConversions.value?.details_to_organization ?? [])
const organizationToSetupDaily = computed(() => latestDailyConversions.value?.organization_to_setup ?? [])
const hasConversionData = (points: readonly { started: number }[]) => points.some(point => point.started > 0)
const v1FunnelStages = computed(() => buildFrontendOnboardingFunnelStages(visibleAnalytics.value?.funnels.v1 ?? []))
const v4FunnelStages = computed(() => buildFrontendOnboardingFunnelStages(displayedV4Funnel.value))
const v1FunnelSummaries = computed(() => buildFrontendOnboardingFunnelSummaries(visibleAnalytics.value?.funnels.v1 ?? []))
const v4FunnelSummaries = computed(() => buildFrontendOnboardingFunnelSummaries(displayedV4Funnel.value))
const hasDailyAttempts = computed(() => displayedDailyAttempts.value
  .some(day => day.v1_attempts > 0 || day.v2_attempts > 0 || day.v3_attempts > 0 || (day.v4_attempts ?? 0) > 0))
const hasWelcomeOutcomeData = computed(() => displayedWelcomeOutcomes.value.some(day => (
  day.welcome_advanced_to_intent > 0
  || day.welcome_not_viewed > 0
  || day.welcome_did_not_advance > 0
)))
const setupCliOutcomes = computed(() => visibleAnalytics.value?.v2_v4_setup_cli_outcomes
  ?? visibleAnalytics.value?.v2_v3_setup_cli_outcomes
  ?? {
    total_users: 0,
    cli_only: 0,
    cli_and_ai_instructions: 0,
    no_cli: 0,
  })
const setupCliOutcomeLabels = computed(() => [
  t('frontend-onboarding-setup-cli-only'),
  t('frontend-onboarding-setup-cli-and-ai'),
  t('frontend-onboarding-setup-no-cli'),
])
const setupCliOutcomeValues = computed(() => [
  setupCliOutcomes.value.cli_only,
  setupCliOutcomes.value.cli_and_ai_instructions,
  setupCliOutcomes.value.no_cli,
])
const setupCliOutcomeColors = ['#119eff', '#8b5cf6', '#94a3b8']
const hasSetupCliOutcomeData = computed(() => setupCliOutcomes.value.total_users > 0)
const dailySetupCliOutcomeLabels = computed<Record<FrontendOnboardingDailySetupCliOutcomeKey, string>>(() => ({
  cli_copy_init: t('frontend-onboarding-daily-setup-cli-cli-copy-init'),
  ai_copy_init: t('frontend-onboarding-daily-setup-cli-ai-copy-init'),
  both_copy_init: t('frontend-onboarding-daily-setup-cli-both-copy-init'),
  no_copy_init: t('frontend-onboarding-daily-setup-cli-no-copy-init'),
  cli_copy_other_cli: t('frontend-onboarding-daily-setup-cli-cli-copy-other-cli'),
  ai_copy_other_cli: t('frontend-onboarding-daily-setup-cli-ai-copy-other-cli'),
  both_copy_other_cli: t('frontend-onboarding-daily-setup-cli-both-copy-other-cli'),
  no_copy_other_cli: t('frontend-onboarding-daily-setup-cli-no-copy-other-cli'),
  cli_copy_no_cli: t('frontend-onboarding-daily-setup-cli-cli-copy-no-cli'),
  ai_copy_no_cli: t('frontend-onboarding-daily-setup-cli-ai-copy-no-cli'),
  both_copy_no_cli: t('frontend-onboarding-daily-setup-cli-both-copy-no-cli'),
  no_action: t('frontend-onboarding-daily-setup-cli-no-action'),
}))
const dailySetupCliSeries = computed(() => buildFrontendOnboardingDailySetupCliSeries(
  visibleAnalytics.value?.daily_setup_cli_outcomes ?? [],
  dailySetupCliOutcomeLabels.value,
  t('frontend-onboarding-daily-setup-cli-first-time'),
  t('frontend-onboarding-daily-setup-cli-returning'),
))
const hasDailySetupCliOutcomeData = computed(() => dailySetupCliSeries.value.length > 0)

const onboardingGraphSource = computed(() => {
  const v4Funnel = visibleAnalytics.value?.funnels.v4
  const v4Nodes = visibleAnalytics.value?.v4_graph?.nodes
  if (v4Funnel !== undefined && v4Nodes !== undefined) {
    return {
      version: 'v4',
      funnel: v4Funnel,
      nodes: v4Nodes,
    } as const
  }

  return {
    version: 'v3',
    funnel: visibleAnalytics.value?.funnels.v3 ?? [],
    nodes: visibleAnalytics.value?.v3_graph?.nodes ?? [],
  } as const
})
const graphTitle = computed(() => t(onboardingGraphSource.value.version === 'v4'
  ? 'frontend-onboarding-graph-v4'
  : 'frontend-onboarding-graph-v3'))
const graphDescription = computed(() => t(onboardingGraphSource.value.version === 'v4'
  ? 'frontend-onboarding-graph-v4-description'
  : 'frontend-onboarding-graph-v3-description'))

const onboardingGraphV4 = computed<AdminOnboardingJourneyGraphConfig>(() => {
  const { funnel, nodes: interactionNodes } = onboardingGraphSource.value
  const stage = (key: FrontendOnboardingStageKey) => funnel.find(item => item.key === key)
  const intent = stage('intent')
  const details = stage('details')
  const organization = stage('organization')
  const setup = stage('setup')
  const parentPercent = (current: number, previous: number) => previous > 0 ? current / previous * 100 : 0
  const graphMetrics = {
    ...buildFrontendOnboardingGraphMetrics(v4DetailsGraphDefinitions, interactionNodes, details?.reached),
    ...buildFrontendOnboardingGraphMetrics(v4OrganizationGraphDefinitions, interactionNodes, organization?.reached),
    ...buildFrontendOnboardingGraphMetrics(v4SetupGraphDefinitions, interactionNodes, setup?.reached),
  }
  const mapEventNodes = (
    nodes: readonly (typeof v4DetailsGraphEventNodes[number] | typeof v4OrganizationGraphEventNodes[number] | typeof v4SetupGraphEventNodes[number])[],
    levelLabelKey: string,
  ): AdminOnboardingJourneyNode[] => nodes.map((node) => {
    const metric = graphMetrics[node.eventKey]
    return {
      id: node.id,
      label: t(node.labelKey),
      count: metric?.count ?? 0,
      levelPercent: metric?.levelPercent ?? 0,
      previousPercent: metric?.previousPercent,
      levelLabel: t(levelLabelKey),
      x: node.x,
      y: node.y,
      kind: 'event',
      icon: node.icon,
      ...('tone' in node ? { tone: node.tone } : {}),
    }
  })
  const eventNodes = [
    ...mapEventNodes(v4DetailsGraphEventNodes, 'frontend-onboarding-graph-stage-app-details'),
    ...mapEventNodes(v4OrganizationGraphEventNodes, 'frontend-onboarding-graph-stage-organization-details'),
    ...mapEventNodes(v4SetupGraphEventNodes, 'frontend-onboarding-graph-stage-setup-reached'),
  ]

  return {
    width: 5500,
    height: 1100,
    levels: [
      { label: '1', start: 0, end: 300, divider: 300 },
      { label: '2', start: 300, end: 2200, divider: 2200 },
      { label: '3', start: 2200, end: 4400, divider: 4400 },
      { label: '4', start: 4400, end: 5500 },
    ],
    nodes: [
      { id: 'intent', label: t('frontend-onboarding-graph-stage-intent'), count: intent?.reached ?? 0, totalPercent: intent?.of_start_percent ?? 0, x: 145, y: 540, kind: 'stage', icon: 'intent' },
      {
        id: 'details',
        label: t('frontend-onboarding-graph-stage-app-details'),
        count: details?.reached ?? 0,
        totalPercent: details?.of_start_percent ?? 0,
        parentPercent: parentPercent(details?.reached ?? 0, intent?.reached ?? 0),
        x: 455,
        y: 540,
        kind: 'stage',
        icon: 'details',
      },
      ...eventNodes,
      {
        id: 'organization',
        label: t('frontend-onboarding-graph-stage-organization-details'),
        count: organization?.reached ?? 0,
        totalPercent: organization?.of_start_percent ?? 0,
        parentPercent: parentPercent(organization?.reached ?? 0, details?.reached ?? 0),
        x: 2400,
        y: 540,
        kind: 'stage',
        icon: 'organization',
        width: 280,
      },
      {
        id: 'setup',
        label: t('frontend-onboarding-graph-stage-setup-reached'),
        count: setup?.reached ?? 0,
        totalPercent: setup?.of_start_percent ?? 0,
        parentPercent: parentPercent(setup?.reached ?? 0, organization?.reached ?? 0),
        x: 4650,
        y: 540,
        kind: 'stage',
        icon: 'setup',
        width: 250,
      },
    ],
    edges: [
      { from: 'intent', to: 'details', style: 'primary' },
      { from: 'details', to: 'app_name', style: 'branch' },
      { from: 'details', to: 'app_id', style: 'branch' },
      { from: 'details', to: 'learn_more', style: 'branch' },
      { from: 'details', to: 'store_opened', style: 'branch' },
      { from: 'store_opened', to: 'import_closed', style: 'branch' },
      { from: 'store_opened', to: 'store_url', style: 'branch' },
      { from: 'store_url', to: 'import_clicked', style: 'branch' },
      { from: 'import_clicked', to: 'import_succeeded', style: 'branch' },
      { from: 'import_clicked', to: 'import_failed', style: 'branch' },
      { from: 'details', to: 'picker_opened', style: 'branch' },
      { from: 'picker_opened', to: 'picker_failed', style: 'branch' },
      { from: 'picker_opened', to: 'picker_closed', style: 'branch' },
      { from: 'picker_opened', to: 'icon_picked', style: 'branch' },
      { from: 'icon_picked', to: 'icon_uploaded', style: 'branch' },
      { from: 'icon_picked', to: 'icon_upload_failed', style: 'branch' },
      { from: 'app_name', toPoint: { x: 2130, y: 90 }, style: 'dotted' },
      { from: 'app_id', toPoint: { x: 2130, y: 195 }, style: 'dotted' },
      { from: 'learn_more', toPoint: { x: 2130, y: 300 }, style: 'dotted' },
      { from: 'import_closed', toPoint: { x: 2130, y: 405 }, style: 'dotted' },
      { from: 'import_succeeded', toPoint: { x: 2130, y: 455 }, style: 'dotted' },
      { from: 'import_failed', toPoint: { x: 2130, y: 555 }, style: 'dotted' },
      { from: 'picker_failed', toPoint: { x: 2130, y: 620 }, style: 'dotted' },
      { from: 'picker_closed', toPoint: { x: 2130, y: 720 }, style: 'dotted' },
      { from: 'icon_uploaded', toPoint: { x: 2130, y: 770 }, style: 'dotted' },
      { from: 'icon_upload_failed', toPoint: { x: 2130, y: 870 }, style: 'dotted' },
      { fromPoint: { x: 2130, y: 90 }, toPoint: { x: 2130, y: 870 }, style: 'dotted', arrow: false },
      { fromPoint: { x: 2130, y: 540 }, to: 'organization', style: 'primary' },
      { from: 'organization', to: 'organization_import_opened', style: 'branch' },
      { from: 'organization_import_opened', to: 'organization_import_submitted', style: 'branch' },
      { from: 'organization_import_submitted', to: 'organization_import_succeeded', style: 'branch' },
      { from: 'organization_import_submitted', to: 'organization_import_failed', style: 'branch' },
      { from: 'organization', to: 'organization_invite_viewed', style: 'branch' },
      { from: 'organization_invite_viewed', to: 'organization_invite_opened', style: 'branch' },
      { from: 'organization_invite_opened', to: 'organization_invite_succeeded', style: 'branch' },
      { from: 'organization_invite_viewed', to: 'organization_invite_continued', style: 'branch' },
      { from: 'organization', to: 'app_creation_started', style: 'branch' },
      { from: 'app_creation_started', to: 'app_creation_succeeded', style: 'branch' },
      { from: 'app_creation_started', to: 'app_creation_failed', style: 'branch' },
      { from: 'organization_import_succeeded', toPoint: { x: 4200, y: 110 }, style: 'dotted' },
      { from: 'organization_import_failed', toPoint: { x: 4200, y: 210 }, style: 'dotted' },
      { from: 'organization_invite_continued', toPoint: { x: 4200, y: 700 }, style: 'dotted' },
      { from: 'app_creation_succeeded', toPoint: { x: 4200, y: 800 }, style: 'dotted' },
      { from: 'app_creation_failed', toPoint: { x: 4200, y: 900 }, style: 'dotted' },
      { fromPoint: { x: 4200, y: 110 }, toPoint: { x: 4200, y: 900 }, style: 'dotted', arrow: false },
      { from: 'organization', toPoint: { x: 4200, y: 540 }, style: 'primary' },
      { fromPoint: { x: 4200, y: 540 }, to: 'setup', style: 'primary' },
      { from: 'setup', to: 'technical_invite_opened', style: 'branch' },
      { from: 'technical_invite_opened', to: 'technical_invite_succeeded', style: 'branch' },
    ],
    formatters: {
      levelPercent: (percent, level) => t('frontend-onboarding-graph-percent-of-level', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
        level,
      }),
      totalPercent: percent => t('frontend-onboarding-graph-percent-of-total', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
      }),
      previousPercent: percent => t('frontend-onboarding-graph-percent-of-previous', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
      }),
      parentPercent: percent => t('frontend-onboarding-graph-percent-of-parent-stage', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
      }),
    },
  }
})
const attemptsValue = computed(() => formatNumberValue(kpis.value?.attempts ?? 0))
const completionValue = computed(() => `${formatNumberValue(kpis.value?.completion_rate ?? 0, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})}%`)
const completionSubtitle = computed(() => t('frontend-onboarding-completed-subtitle', {
  count: formatNumberValue(kpis.value?.completed ?? 0),
}))
const largestDropoffValue = computed(() => kpis.value?.largest_dropoff
  ? `${formatNumberValue(kpis.value.largest_dropoff.percentage, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`
  : '—')
const largestDropoffSubtitle = computed(() => {
  const dropoff = kpis.value?.largest_dropoff
  if (!dropoff)
    return t('frontend-onboarding-no-dropoff')

  const stages = rawLatestFunnel.value.stages
  const from = stages.find(stage => stage.key === dropoff.from)?.label ?? dropoff.from
  const to = stages.find(stage => stage.key === dropoff.to)?.label ?? dropoff.to
  return t('frontend-onboarding-transition', { from, to })
})

watch(() => adminStore.activeDateRange, () => {
  if (!isReady.value)
    return
  void loadAnalytics()
}, { deep: true })

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access frontend onboarding analytics')
    await router.push('/dashboard')
    return
  }

  isReady.value = true
  void loadAnalytics()
  displayStore.NavTitle = t('frontend-onboarding')
})

displayStore.NavTitle = t('frontend-onboarding')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div class="h-full pb-4 overflow-hidden">
    <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <AdminFilterBar />

      <PageLoader v-if="isLoading" />

      <div v-else class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
            {{ t('frontend-onboarding') }}
          </h1>
          <span class="px-3 py-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded-full dark:bg-indigo-500/20 dark:text-indigo-200">
            {{ latestVersionLabel }}
          </span>
        </div>

        <div v-if="loadError" role="alert" class="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {{ t('frontend-onboarding-load-error') }}
        </div>

        <template v-else>
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatsCard
              :title="t('frontend-onboarding-attempts')"
              :value="attemptsValue"
              :subtitle="t('frontend-onboarding-attempts-subtitle')"
              color-class="text-indigo-500"
              :is-loading="isLoadingStats"
            />
            <AdminStatsCard
              :title="t('frontend-onboarding-completed')"
              :value="completionValue"
              :subtitle="completionSubtitle"
              color-class="text-emerald-500"
              :is-loading="isLoadingStats"
            />
            <AdminStatsCard
              :title="t('frontend-onboarding-median-time')"
              :value="formatFrontendOnboardingDuration(kpis?.median_completion_ms ?? null)"
              :subtitle="t('frontend-onboarding-median-time-subtitle')"
              color-class="text-amber-500"
              :is-loading="isLoadingStats"
            />
            <AdminStatsCard
              :title="t('frontend-onboarding-largest-dropoff')"
              :value="largestDropoffValue"
              :subtitle="largestDropoffSubtitle"
              color-class="text-rose-500"
              :is-loading="isLoadingStats"
            />
          </div>

          <ChartCard
            chart-id="daily-attempts"
            :title="t('frontend-onboarding-daily-attempts')"
            :is-loading="isLoadingStats"
            :has-data="hasDailyAttempts"
          >
            <AdminStackedBarChart :series="dailySeries" :is-loading="isLoadingStats" />
            <AdminChartDeduplicateControl
              v-model="deduplicateDailyAttempts"
              :chart-label="t('frontend-onboarding-daily-attempts')"
            />
          </ChartCard>

          <ChartCard
            chart-id="funnel-v4"
            :title="displayedFunnelTitle"
            :is-loading="isLoadingStats"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ displayedFunnelTitle }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('frontend-onboarding-funnel-description') }}
                </p>
              </div>
            </template>
            <div class="mt-6 h-72 sm:h-80">
              <AdminFunnelChart :stages="v4FunnelStages" />
            </div>
            <div class="grid grid-cols-2 gap-4 pt-5 mt-5 border-t border-slate-200 md:grid-cols-3 xl:grid-cols-6 dark:border-slate-700">
              <div v-for="summary in v4FunnelSummaries" :key="summary.key" class="text-center">
                <p class="text-xl font-bold text-slate-900 tabular-nums dark:text-white">
                  {{ formatNumberValue(summary.conversion_percent) }}%
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ summary.from_label ? t('frontend-onboarding-transition', { from: summary.from_label, to: summary.to_label }) : summary.to_label }} · {{ formatNumberValue(summary.reached) }}
                </p>
              </div>
            </div>
            <AdminChartDeduplicateControl
              v-model="deduplicateV4Funnel"
              :chart-label="displayedFunnelTitle"
            />
          </ChartCard>

          <ChartCard
            chart-id="welcome-outcomes-v4"
            :title="t('frontend-onboarding-welcome-outcomes-v4')"
            :is-loading="isLoadingStats"
            :has-data="hasWelcomeOutcomeData"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ t('frontend-onboarding-welcome-outcomes-v4') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('frontend-onboarding-welcome-outcomes-v4-description') }}
                </p>
              </div>
            </template>
            <AdminStackedBarChart
              :series="welcomeOutcomeSeries"
              :is-loading="isLoadingStats"
              accessible-borders
            />
            <AdminChartDeduplicateControl
              v-model="deduplicateWelcomeOutcomes"
              :chart-label="t('frontend-onboarding-welcome-outcomes-v4')"
            />
          </ChartCard>

          <ChartCard
            chart-id="daily-intent-to-details"
            :title="t('frontend-onboarding-daily-intent-to-details')"
            :is-loading="isLoadingStats"
            :has-data="hasConversionData(intentToDetailsDaily)"
          >
            <AdminDailyConversionChart
              :points="intentToDetailsDaily"
              :label="t('frontend-onboarding-daily-conversion')"
              :attempts-label="t('frontend-onboarding-daily-conversion-attempts')"
              color="#6366f1"
              :is-loading="isLoadingStats"
            />
          </ChartCard>

          <ChartCard
            chart-id="daily-details-to-organization"
            :title="t('frontend-onboarding-daily-details-to-organization')"
            :is-loading="isLoadingStats"
            :has-data="hasConversionData(detailsToOrganizationDaily)"
          >
            <AdminDailyConversionChart
              :points="detailsToOrganizationDaily"
              :label="t('frontend-onboarding-daily-conversion')"
              :attempts-label="t('frontend-onboarding-daily-conversion-attempts')"
              color="#8b5cf6"
              :is-loading="isLoadingStats"
            />
          </ChartCard>

          <ChartCard
            chart-id="daily-organization-to-setup"
            :title="t('frontend-onboarding-daily-organization-to-setup')"
            :is-loading="isLoadingStats"
            :has-data="hasConversionData(organizationToSetupDaily)"
          >
            <AdminDailyConversionChart
              :points="organizationToSetupDaily"
              :label="t('frontend-onboarding-daily-conversion')"
              :attempts-label="t('frontend-onboarding-daily-conversion-attempts')"
              color="#10b981"
              :is-loading="isLoadingStats"
            />
          </ChartCard>

          <ChartCard
            chart-id="journey-graph-v4"
            :title="graphTitle"
            :is-loading="isLoadingStats"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ graphTitle }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ graphDescription }}
                </p>
              </div>
            </template>
            <div class="mt-1">
              <AdminOnboardingJourneyGraph :config="onboardingGraphV4" />
            </div>
          </ChartCard>

          <ChartCard
            chart-id="setup-cli-outcomes-v2-v4"
            :title="t('frontend-onboarding-setup-cli-outcomes-v2-v4')"
            :total="setupCliOutcomes.total_users"
            :unit="t('frontend-onboarding-people')"
            :is-loading="isLoadingStats"
            :has-data="hasSetupCliOutcomeData"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ t('frontend-onboarding-setup-cli-outcomes-v2-v4') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('frontend-onboarding-setup-cli-outcomes-description') }}
                </p>
              </div>
            </template>
            <AdminBarChart
              :labels="setupCliOutcomeLabels"
              :values="setupCliOutcomeValues"
              :colors="setupCliOutcomeColors"
              :label="t('frontend-onboarding-people')"
              :total="setupCliOutcomes.total_users"
              value-mode="count"
              orientation="vertical"
              :is-loading="isLoadingStats"
            />
          </ChartCard>

          <ChartCard
            chart-id="daily-setup-cli-outcomes-v2-v4"
            :title="t('frontend-onboarding-daily-setup-cli-outcomes-v2-v4')"
            :is-loading="isLoadingStats"
            :has-data="hasDailySetupCliOutcomeData"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ t('frontend-onboarding-daily-setup-cli-outcomes-v2-v4') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('frontend-onboarding-daily-setup-cli-outcomes-description') }}
                </p>
              </div>
            </template>
            <AdminStackedBarChart
              :series="dailySetupCliSeries"
              :is-loading="isLoadingStats"
              accessible-borders
            />
          </ChartCard>

          <ChartCard
            chart-id="funnel-v1-legacy"
            :title="t('frontend-onboarding-funnel-v1-legacy')"
            :is-loading="isLoadingStats"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ t('frontend-onboarding-funnel-v1-legacy') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('frontend-onboarding-funnel-description') }}
                </p>
              </div>
            </template>
            <div class="mt-6 h-72 sm:h-80">
              <AdminFunnelChart :stages="v1FunnelStages" />
            </div>
            <div class="grid grid-cols-2 gap-4 pt-5 mt-5 border-t border-slate-200 md:grid-cols-4 dark:border-slate-700">
              <div v-for="summary in v1FunnelSummaries" :key="summary.key" class="text-center">
                <p class="text-xl font-bold text-slate-900 tabular-nums dark:text-white">
                  {{ formatNumberValue(summary.conversion_percent) }}%
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ summary.from_label ? t('frontend-onboarding-transition', { from: summary.from_label, to: summary.to_label }) : summary.to_label }} · {{ formatNumberValue(summary.reached) }}
                </p>
              </div>
            </div>
          </ChartCard>
        </template>
      </div>
    </div>
  </div>
</template>
