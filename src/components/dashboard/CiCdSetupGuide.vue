<script setup lang="ts">
import type { Json } from '~/types/database.types'
import type { CiEncryptionBundle } from '~/utils/cicdEncryption'
import type { CiKeySpec, CiPlatform, CiProduct, CiProvider, CiSecretName, CiStrategy } from '~/utils/cicdSetupGuide'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import IconArrowLeft from '~icons/lucide/arrow-left'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconFileText from '~icons/lucide/file-text'
import IconGitBranch from '~icons/lucide/git-branch'
import IconGitMerge from '~icons/lucide/git-merge'
import IconGitPullRequest from '~icons/lucide/git-pull-request'
import IconInfo from '~icons/lucide/info'
import IconKey from '~icons/lucide/key-round'
import IconLoader from '~icons/lucide/loader-2'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconTerminal from '~icons/lucide/terminal'
import IconTriangleAlert from '~icons/lucide/triangle-alert'
import IconAndroid from '~icons/mdi/android'
import IconApple from '~icons/mdi/apple'
import IconAzure from '~icons/simple-icons/azurepipelines'
import IconBitbucket from '~icons/simple-icons/bitbucket'
import IconCircleci from '~icons/simple-icons/circleci'
import IconGithub from '~icons/simple-icons/githubactions'
import IconGitlab from '~icons/simple-icons/gitlab'
import { createDefaultApiKey } from '~/services/apikeys'
import { getCapgoApiErrorCode } from '~/services/capgoApi'
import { setCiCdReminderDismissed } from '~/services/cicdReminder'
import { useConsole } from '~/services/console'
import { formatDate } from '~/services/date'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { ciChannelEncryptionBundles, ciProductionEncryptionEvidence } from '~/utils/cicdEncryption'
import {
  buildCiPipeline,
  BUILDER_PREVIEW_SCOPE,
  builderCredentialsPushCommand,
  CI_ENCRYPTION_SECRET,
  CI_PLATFORMS,
  CI_PROVIDERS,
  CI_STRATEGIES,
  DEFAULT_PREPROD_BRANCH,
  DEFAULT_PRODUCTION_BRANCH,
  ENCRYPTED_PREVIEW_SCOPE,
  encryptionSecretCommand,
  githubSecretCommand,
  isCiChannelSupported,
  loadCiGuideSelection,
  normalizeCiBranch,
  normalizeCiChannels,
  PREPROD_CHANNEL,
  previewCleanupCommand,
  saveCiGuideSelection,
} from '~/utils/cicdSetupGuide'
import { ciCdDetectedAt, parseCiCdSetupState, withCiCdMarkedDone } from '~/utils/cicdSetupState'
import { getAppGettingStartedPath } from '~/utils/onboardingRedirect'

const props = defineProps<{
  appId: string
  ownerOrgId: string
  initialProduct: CiProduct
  initialPlatform?: CiPlatform
}>()

const { t } = useI18n()
const router = useRouter()
const capgo = useConsole()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const userId = computed(() => main.user?.id ?? main.auth?.id ?? null)

const saved = loadCiGuideSelection(userId.value, props.appId)
const product = computed(() => props.initialProduct)
const strategy = ref<CiStrategy>(saved.strategy ?? 'main')
const provider = ref<CiProvider | null>(saved.provider ?? null)
const platforms = ref<CiPlatform[]>(props.initialPlatform ? [props.initialPlatform] : saved.platforms ?? [...CI_PLATFORMS])
const productionBranchInput = ref(saved.productionBranch ?? DEFAULT_PRODUCTION_BRANCH)
const preprodBranchInput = ref(saved.preprodBranch ?? DEFAULT_PREPROD_BRANCH)
const preprodChannel = ref(saved.preprodChannel ?? PREPROD_CHANNEL)
const selectedProductionChannel = ref(saved.productionChannel ?? '')
const productionBranch = computed(() => normalizeCiBranch(productionBranchInput.value, DEFAULT_PRODUCTION_BRANCH))
const preprodBranch = computed(() => normalizeCiBranch(preprodBranchInput.value, DEFAULT_PREPROD_BRANCH))
const productionBranchInvalid = computed(() => productionBranchInput.value.trim() !== productionBranch.value)
const branchesEqual = computed(() => strategy.value === 'main_preprod' && productionBranch.value === preprodBranch.value)
const releaseBranches = computed(() => strategy.value === 'main_preprod' ? [productionBranch.value, preprodBranch.value] : [productionBranch.value])
const releaseBranchRefs = computed(() => releaseBranches.value.map(branch => `refs/heads/${branch}`).join(', '))
const circleReleaseExpression = computed(() => releaseBranches.value.map(branch => `pipeline.git.branch == "${branch}"`).join(' or '))
const preprodBranchInvalid = computed(() => preprodBranchInput.value.trim() !== preprodBranch.value)

// undefined while loading; null when the app has no default channel yet.
// Apps can have one default channel per platform: CI uploads to all of them.
const defaultChannels = ref<string[] | null | undefined>(undefined)
const availableChannels = ref<string[]>([])
const channelBundles = ref<Record<string, (CiEncryptionBundle | null)[]>>({})
type LoadStatus = 'loading' | 'ready' | 'error'
const channelStatus = ref<LoadStatus>('loading')
const productionChannels = computed(() => {
  if (defaultChannels.value?.length)
    return normalizeCiChannels(defaultChannels.value)
  if (availableChannels.value.includes(selectedProductionChannel.value))
    return [selectedProductionChannel.value]
  return []
})
const productionChannel = computed(() => productionChannels.value.join(', '))
const productionTargetMissing = computed(() => product.value === 'ota' && productionChannels.value.length === 0)
const showTesterChannel = computed(() => product.value === 'ota' && strategy.value === 'main_preprod')
const testerChannelInvalid = computed(() => showTesterChannel.value && !isCiChannelSupported(preprodChannel.value))
const testerChannelCollision = computed(() => showTesterChannel.value && productionChannels.value.includes(preprodChannel.value))

// Encrypted apps need the private key in CI, or the CLI uploads plaintext
// bundles (or fails when the organization enforces encryption).
const encryptionRequired = ref(false)
const encryptionEvidence = computed(() => ciProductionEncryptionEvidence(productionChannels.value.flatMap(name => channelBundles.value[name] ?? [null])))
const encryptionDetected = computed(() => encryptionEvidence.value === 'encrypted')
const encryptionStatus = ref<LoadStatus>('loading')
const encryptedChoice = ref<boolean | null>(null)
const encrypted = computed(() => encryptionRequired.value || (encryptedChoice.value ?? encryptionDetected.value))
const encryptionChoiceRequired = computed(() => product.value === 'ota' && channelStatus.value === 'ready' && encryptionStatus.value === 'ready'
  && !productionTargetMissing.value && !encryptionRequired.value && encryptionEvidence.value === 'unknown')
const encryptionChoiceMissing = computed(() => encryptionChoiceRequired.value && encryptedChoice.value === null)
watch(productionChannel, () => {
  encryptedChoice.value = null
}, { flush: 'sync' })

// Never swap in another channel: CI would ship to a channel the user didn't pick.
const unsupportedChannel = computed(() => productionChannels.value.find(channel => !isCiChannelSupported(channel)))
const channelUnsupported = computed(() => product.value === 'ota' && unsupportedChannel.value !== undefined)
const pipeline = computed(() => provider.value && !productionTargetMissing.value && !encryptionChoiceMissing.value && !channelUnsupported.value && !branchesEqual.value
  && !testerChannelInvalid.value && !testerChannelCollision.value
  && (product.value !== 'ota' || (channelStatus.value === 'ready' && encryptionStatus.value === 'ready'))
  ? buildCiPipeline({
      appId: props.appId,
      product: product.value,
      strategy: strategy.value,
      provider: provider.value,
      platforms: platforms.value,
      productionChannels: productionChannels.value,
      preprodChannel: preprodChannel.value,
      encrypted: encrypted.value,
      productionBranch: productionBranch.value,
      preprodBranch: preprodBranch.value,
    })
  : null)

const providerIcons: Record<CiProvider, unknown> = {
  github: IconGithub,
  gitlab: IconGitlab,
  azure: IconAzure,
  bitbucket: IconBitbucket,
  circleci: IconCircleci,
  other: IconTerminal,
}
const strategyIcons: Record<CiStrategy, unknown> = {
  main: IconGitBranch,
  main_preprod: IconGitMerge,
  pull_request: IconGitPullRequest,
}
const roleLabels: Record<CiKeySpec['role'], string> = {
  app_uploader: 'role-app-uploader',
  app_developer: 'role-app-developer',
  app_preview: 'role-app-preview',
  app_admin: 'role-app-admin',
}
const providerName = computed(() => provider.value ? t(`cicd-guide-provider-${provider.value}`) : '')
const builderPreview = computed(() => product.value === 'builder' && strategy.value === 'pull_request')
const encryptedPreview = computed(() => product.value === 'ota' && encrypted.value && strategy.value === 'pull_request')
const protectedPreview = computed(() => builderPreview.value || encryptedPreview.value)
const previewScope = computed(() => {
  if (builderPreview.value)
    return BUILDER_PREVIEW_SCOPE
  if (encryptedPreview.value)
    return provider.value === 'gitlab' ? 'capgo/pr-*' : ENCRYPTED_PREVIEW_SCOPE
  return 'capgo-preview'
})
const checklistPath = computed(() => `${getAppGettingStartedPath(props.appId)}?showChecklist=1${product.value === 'builder' ? '&path=builder' : ''}`)
const docsHref = computed(() => product.value === 'ota'
  ? 'https://capgo.app/docs/getting-started/cicd-integration/'
  : 'https://capgo.app/docs/builder/github-actions/')
const strategyParams = computed(() => ({
  branch: productionBranch.value,
  preprod: preprodBranch.value,
  channel: productionChannel.value || t('cicd-guide-production-target-pending'),
  channelLabel: productionChannel.value ? t('cicd-guide-production-channel-label', { channel: productionChannel.value }) : t('cicd-guide-production-target-pending'),
  testerChannel: preprodChannel.value,
}))

// Keyed by secret and role: a key made for another answer (uploader vs admin)
// cannot run this pipeline, so a changed role asks for a new key.
type CiKeySlot = `${CiSecretName}:${CiKeySpec['role']}`
const keySlot = (spec: CiKeySpec): CiKeySlot => `${spec.secret}:${spec.role}`
function keyScope(spec: CiKeySpec) {
  if (spec.purpose === 'release')
    return 'capgo-release'
  if (provider.value === 'gitlab' && product.value === 'ota')
    return 'capgo/pr-*'
  return previewScope.value
}
function secretInstruction(spec: CiKeySpec) {
  if (provider.value === 'github' && spec.purpose === 'preview')
    return protectedPreview.value ? 'cicd-guide-secret-github-builder-preview' : 'cicd-guide-secret-github-preview'
  return `cicd-guide-secret-${provider.value}-2`
}
const createdKeys = reactive<Partial<Record<CiKeySlot, string>>>({})
const creatingKey = reactive<Partial<Record<CiKeySlot, boolean>>>({})
const keyErrors = reactive<Partial<Record<CiKeySlot, 'permission' | 'generic'>>>({})
interface KeyRegistration {
  status: 'pending' | 'saving' | 'saved' | 'error'
  appId: string
  rbacId: string
  selection: { product: CiProduct, strategy: CiStrategy, provider: CiProvider | null }
}
const keyRegistrations = reactive<Partial<Record<CiKeySlot, KeyRegistration>>>({})

watch([product, strategy, provider, platforms, productionBranch, preprodBranch, preprodChannel, selectedProductionChannel], () => {
  if (!provider.value)
    return
  saveCiGuideSelection(userId.value, props.appId, {
    product: product.value,
    strategy: strategy.value,
    provider: provider.value,
    platforms: platforms.value,
    productionBranch: productionBranch.value,
    preprodBranch: preprodBranch.value,
    preprodChannel: preprodChannel.value,
    productionChannel: selectedProductionChannel.value,
  })
}, { deep: true })

function track(event: string, properties: Record<string, string | number | boolean> = {}) {
  sendOnboardingEvent(event, {
    app_id: props.appId,
    org_id: props.ownerOrgId,
    product: product.value,
    strategy: strategy.value,
    ...(provider.value ? { provider: provider.value } : {}),
    ...properties,
  })
}

watch(provider, (value, previous) => {
  if (value && value !== previous)
    track('onboarding_cicd_provider_selected')
})

function togglePlatform(platform: CiPlatform, event: Event) {
  const next = platforms.value.includes(platform)
    ? platforms.value.filter(entry => entry !== platform)
    : [...platforms.value, platform]
  // Keep at least one platform: an empty pipeline would build nothing.
  if (next.length)
    platforms.value = CI_PLATFORMS.filter(entry => next.includes(entry))
  else if (event.target instanceof HTMLInputElement)
    event.target.checked = true
}

async function copy(text: string, event?: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('copied-to-clipboard'))
    if (event)
      track(event)
  }
  catch (error) {
    console.error('Cannot copy CI/CD setup text', error)
    toast.error(t('cannot-copy'))
  }
}

async function createKey(spec: CiKeySpec) {
  const slot = keySlot(spec)
  if (creatingKey[slot])
    return
  creatingKey[slot] = true
  keyErrors[slot] = undefined
  const appId = props.appId
  const selection = { product: product.value, strategy: strategy.value, provider: provider.value }
  try {
    const name = `${providerName.value || 'CI'} ${spec.purpose === 'preview' ? 'previews' : 'CI'} (${appId})`
    const { data, error } = await createDefaultApiKey(capgo, name, { appId, appRole: spec.role, hashed: true })
    if (error)
      throw error
    const key = (data as { key?: unknown } | null)?.key
    if (typeof key !== 'string' || !key)
      throw new Error('The API returned no key')
    if (appId !== props.appId)
      return
    createdKeys[slot] = key
    track('onboarding_cicd_key_created', { role: spec.role })
    const rbacId = (data as { rbac_id?: unknown } | null)?.rbac_id
    if (typeof rbacId === 'string' && rbacId) {
      keyRegistrations[slot] = {
        status: 'pending',
        appId,
        rbacId,
        selection,
      }
      void recordCreatedKey(spec)
    }
  }
  catch (error) {
    console.error('Cannot create CI API key', error)
    const code = await getCapgoApiErrorCode(error)
    keyErrors[slot] = code === 'forbidden_binding' || code === 'not_authorized' ? 'permission' : 'generic'
  }
  finally {
    creatingKey[slot] = false
  }
}

let policyRequest = 0
let channelRequest = 0

async function loadEncryptionState() {
  const appId = props.appId
  const ownerOrgId = props.ownerOrgId
  const request = ++policyRequest
  encryptionStatus.value = 'loading'
  try {
    const { data, error } = await capgo.rpc('get_app_cicd_encryption_policy', { p_app_id: appId }).single()
    if (request !== policyRequest || appId !== props.appId || ownerOrgId !== props.ownerOrgId)
      return
    if (error)
      throw error
    if (!data || data.owner_org !== ownerOrgId)
      throw new Error('The app organization encryption policy is unavailable')
    encryptionRequired.value = data.enforce_encrypted_bundles
    encryptionStatus.value = 'ready'
  }
  catch (error) {
    console.error('Cannot check CI/CD bundle encryption', error)
    if (request === policyRequest && appId === props.appId && ownerOrgId === props.ownerOrgId)
      encryptionStatus.value = 'error'
  }
}

async function loadDefaultChannel() {
  const appId = props.appId
  const ownerOrgId = props.ownerOrgId
  const request = ++channelRequest
  channelStatus.value = 'loading'
  encryptedChoice.value = null
  channelBundles.value = {}
  try {
    // Bound the picker and return public defaults before optional private targets.
    const { data, error } = await capgo
      .from('channels')
      .select('name, public, ios, android, electron, version, rollout_enabled, rollout_version, current_version:app_versions!channels_version_fkey(name,key_id,session_key,deleted,deleted_at), rollout_bundle:app_versions!channels_rollout_version_fkey(name,key_id,session_key,deleted,deleted_at)')
      .eq('app_id', appId)
      .order('public', { ascending: false })
      .order('name')
      .limit(1000)
    if (request !== channelRequest || appId !== props.appId || ownerOrgId !== props.ownerOrgId)
      return
    if (error)
      throw error
    const enabled = (data ?? []).filter(row => row.ios || row.android || row.electron)
    channelBundles.value = Object.fromEntries(enabled.filter(row => row.name).map(row => [row.name, ciChannelEncryptionBundles(row)]))
    const names = enabled
      .filter(row => row.public)
      .map(row => row.name)
      .filter((name): name is string => !!name)
    availableChannels.value = normalizeCiChannels(enabled.map(row => row.name))
    if (!availableChannels.value.includes(selectedProductionChannel.value))
      selectedProductionChannel.value = ''
    defaultChannels.value = names.length ? names : null
    channelStatus.value = 'ready'
  }
  catch (error) {
    console.error('Cannot load CI/CD default channels', error)
    if (request === channelRequest && appId === props.appId && ownerOrgId === props.ownerOrgId)
      channelStatus.value = 'error'
  }
}

// CI/CD state from apps.onboarding.cicd. The backend fills the detection fields
// when a bundle upload or build request comes from CI, so polling picks up the
// user's first pipeline run without a reload.
const onboarding = ref<unknown>(organizationStore.getAppByAppId(props.appId)?.onboarding)
const cicdState = computed(() => parseCiCdSetupState(onboarding.value))
const detectedAt = computed(() => product.value === 'ota' ? cicdState.value.otaDetectedAt : cicdState.value.builderDetectedAt)
const statusError = ref(false)
const statusLoading = ref(false)
const markingDone = ref(false)
const skipping = ref(false)
let guideActive = true
let statusTimer: ReturnType<typeof setInterval> | undefined
let statusGeneration = 0
let onboardingWrites = 0
let onboardingWriteQueue = Promise.resolve()

function writeOnboarding(write: () => Promise<void>) {
  onboardingWrites += 1
  statusGeneration += 1
  statusLoading.value = false
  const pending = onboardingWriteQueue.then(write)
  onboardingWriteQueue = pending.catch(() => {})
  return pending.finally(() => {
    onboardingWrites -= 1
  })
}

function applyOnboarding(value: unknown) {
  onboarding.value = value
  organizationStore.updateAppOnboarding(props.appId, value as Json)
}

async function refreshStatus() {
  if (onboardingWrites > 0)
    return
  const generation = ++statusGeneration
  const appId = props.appId
  statusLoading.value = true
  try {
    const { data, error } = await capgo.from('apps').select('onboarding').eq('app_id', appId).maybeSingle()
    if (generation !== statusGeneration || appId !== props.appId)
      return
    statusError.value = !!error
    if (!error && data) {
      const wasDone = !!ciCdDetectedAt(cicdState.value)
      applyOnboarding(data.onboarding)
      if (!wasDone && ciCdDetectedAt(cicdState.value))
        track('onboarding_cicd_detected', { via: cicdState.value.detectedVia ?? 'unknown' })
    }
  }
  finally {
    if (generation === statusGeneration)
      statusLoading.value = false
  }
}

const detectedLabel = computed(() => {
  const state = cicdState.value
  if (!detectedAt.value)
    return ''
  const productVia = product.value === 'ota' ? state.otaDetectedVia : state.builderDetectedVia
  const productProvider = product.value === 'ota' ? state.otaCiProvider : state.builderCiProvider
  const via = productVia ?? state.detectedVia
  const ciProvider = productVia ? productProvider : state.ciProvider
  const fallbackKey = via === 'key' ? 'cicd-guide-status-from-key' : 'cicd-guide-status-from-ci'
  const from = ciProvider && ciProvider !== 'ci' ? ciProvider : t(fallbackKey)
  return t(product.value === 'builder' ? 'cicd-guide-status-detected-builder' : 'cicd-guide-status-detected-ota', { from, date: formatDate(detectedAt.value) })
})

async function markDone() {
  if (markingDone.value)
    return
  markingDone.value = true
  const appId = props.appId
  try {
    await writeOnboarding(async () => {
      const { data, error } = await capgo.rpc('record_app_cicd_setup', { p_app_id: appId, p_event: 'marked_done' })
      if (error)
        throw error
      if (appId === props.appId)
        applyOnboarding(data ?? withCiCdMarkedDone(onboarding.value))
      track('onboarding_cicd_marked_done')
    })
  }
  catch (error) {
    console.error('Cannot mark CI/CD as set up', error)
    toast.error(t('cicd-guide-mark-done-error'))
  }
  finally {
    markingDone.value = false
  }
}

async function skipGuide() {
  if (skipping.value)
    return
  skipping.value = true
  const appId = props.appId
  const routePath = router.currentRoute.value.fullPath
  try {
    await writeOnboarding(async () => {
      const value = await setCiCdReminderDismissed(appId, true)
      if (appId === props.appId)
        applyOnboarding(value)
    })
    if (guideActive && appId === props.appId && router.currentRoute.value.fullPath === routePath) {
      toast.success(t('cicd-reminder-hidden'))
      await router.push(`/app/${encodeURIComponent(appId)}`)
    }
  }
  catch (error) {
    console.error('Cannot skip CI/CD guide', error)
    toast.error(t('cicd-reminder-dismiss-error'))
  }
  finally {
    skipping.value = false
  }
}

// Tracks the guide key so its first use from CI marks this step done, even
// where the CLI cannot tell it runs in CI.
async function recordCreatedKey(spec: CiKeySpec) {
  const registration = keyRegistrations[keySlot(spec)]
  if (!registration || registration.status === 'saving' || registration.status === 'saved')
    return
  registration.status = 'saving'
  try {
    await writeOnboarding(async () => {
      const { data, error } = await capgo.rpc('record_app_cicd_setup', {
        p_app_id: registration.appId,
        p_event: 'key_created',
        p_apikey_rbac_id: registration.rbacId,
        p_selection: registration.selection,
      })
      if (error)
        throw error
      registration.status = 'saved'
      if (data && registration.appId === props.appId)
        applyOnboarding(data)
    })
  }
  catch (error) {
    console.error('Cannot record the CI/CD key', error)
    registration.status = 'error'
  }
}

watch([() => props.appId, () => props.ownerOrgId], () => {
  encryptionRequired.value = false
  defaultChannels.value = undefined
  availableChannels.value = []
  void loadDefaultChannel()
  void loadEncryptionState()
}, { immediate: true })

onMounted(() => {
  void refreshStatus()
  track('onboarding_cicd_guide_opened')
  statusTimer = setInterval(() => {
    if (!detectedAt.value && !statusLoading.value && document.visibilityState === 'visible')
      void refreshStatus()
  }, 15000)
})

onUnmounted(() => {
  guideActive = false
  policyRequest += 1
  channelRequest += 1
  statusGeneration += 1
  if (statusTimer)
    clearInterval(statusTimer)
})

const stepIds = computed(() => {
  const ids: Array<'credentials' | 'key' | 'secret' | 'file' | 'verify'> = []
  if (product.value === 'builder')
    ids.push('credentials')
  ids.push('key', 'secret', 'file', 'verify')
  return ids
})
function stepNumber(id: typeof stepIds.value[number]) {
  return stepIds.value.indexOf(id) + 1
}

function choiceClass(selected: boolean) {
  return selected
    ? 'border-azure-500 bg-azure-500/5 ring-1 ring-azure-500/30 dark:border-azure-400 dark:bg-azure-500/10'
    : 'border-slate-200 bg-white hover:border-slate-400 dark:border-white/15 dark:bg-slate-900 dark:hover:border-white/35'
}
const commandClass = 'd-btn group flex h-auto min-h-11 w-full items-center justify-between gap-3 whitespace-normal rounded-xl border-0 bg-slate-950 px-4 py-3 text-left font-normal hover:bg-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500'
const secondaryLinkClass = 'd-btn d-btn-ghost h-auto min-h-11 gap-2 rounded-lg border-slate-200 bg-transparent px-3 py-2 text-sm font-medium text-slate-600 shadow-none hover:border-slate-300 hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:border-white/15 dark:text-slate-300 dark:hover:border-white/25 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:ring-offset-slate-900'
</script>

<template>
  <div class="mx-auto max-w-[1080px] space-y-8 pb-12" data-test="cicd-guide">
    <header>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <RouterLink :to="checklistPath" class="inline-flex min-h-11 items-center gap-2 rounded-sm text-sm font-medium text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500 dark:text-slate-300" data-test="cicd-guide-back">
          <IconArrowLeft class="h-4 w-4" aria-hidden="true" />
          {{ t('cicd-guide-back') }}
        </RouterLink>
        <button type="button" :class="secondaryLinkClass" :disabled="skipping" data-test="cicd-guide-skip" @click="skipGuide">
          <IconLoader v-if="skipping" class="size-4 motion-safe:animate-spin" aria-hidden="true" />
          {{ t('skip') }}
        </button>
      </div>
      <p class="text-sm font-medium text-sky-700 dark:text-azure-300">
        {{ t('cicd-guide-eyebrow') }}
      </p>
      <h1 class="mt-1 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl dark:text-white">
        {{ t(`cicd-guide-title-${product}`) }}
      </h1>
      <p class="mt-3 max-w-3xl text-base leading-7 text-slate-600 dark:text-slate-300">
        {{ t('cicd-guide-subtitle') }}
      </p>
      <output v-if="detectedAt" class="mt-4 flex items-start gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-200" data-test="cicd-status-detected">
        <IconCheck class="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>{{ detectedLabel }}</span>
      </output>
      <output v-else-if="cicdState.markedDoneAt" class="mt-4 flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700 dark:border-white/15 dark:bg-slate-900 dark:text-slate-200" data-test="cicd-status-marked-done">
        <IconCheck class="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>{{ t('cicd-guide-status-marked-done', { date: formatDate(cicdState.markedDoneAt) }) }}</span>
      </output>
      <button
        v-else
        type="button"
        class="mt-4 inline-flex min-h-11 items-center gap-2 rounded-sm text-sm font-medium text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-azure-500 disabled:opacity-50 dark:text-slate-300"
        :disabled="markingDone"
        data-test="cicd-mark-done"
        @click="markDone"
      >
        <IconLoader v-if="markingDone" class="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
        <IconCheck v-else class="h-4 w-4" aria-hidden="true" />
        {{ t('cicd-guide-mark-done') }}
      </button>
    </header>

    <section :aria-label="t(`cicd-guide-product-${product}`)" class="space-y-3">
      <fieldset v-if="product === 'ota' && encryptionChoiceRequired" class="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200" data-test="cicd-encryption-choice">
        <legend class="px-1 font-semibold">
          {{ t('cicd-guide-encryption-choice-title') }}
        </legend>
        <p>{{ t('cicd-guide-encryption-choice-description') }}</p>
        <div class="flex flex-wrap gap-x-5 gap-y-2">
          <label v-for="choice in [true, false]" :key="String(choice)" class="inline-flex min-h-11 cursor-pointer items-center gap-2">
            <input v-model="encryptedChoice" type="radio" name="production-encryption" :value="choice" class="d-radio d-radio-sm" :data-test="choice ? 'cicd-encryption-choice-encrypted' : 'cicd-encryption-choice-plaintext'">
            {{ t(choice ? 'cicd-guide-encryption-choice-encrypted' : 'cicd-guide-encryption-choice-plaintext') }}
          </label>
        </div>
      </fieldset>
      <div v-else-if="product === 'ota'" class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1" data-test="cicd-encryption">
        <label class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium text-slate-800 dark:text-slate-100" :class="choiceClass(encrypted)">
          <input type="checkbox" class="d-checkbox d-checkbox-sm" :checked="encrypted" :disabled="encryptionRequired || channelStatus !== 'ready' || encryptionStatus !== 'ready'" data-test="cicd-encrypted" @change="encryptedChoice = ($event.target as HTMLInputElement).checked">
          {{ t('cicd-guide-encrypted') }}
        </label>
        <span v-if="encryptionRequired || encryptionDetected" class="text-sm text-slate-500 dark:text-slate-400">
          {{ t(encryptionRequired ? 'cicd-guide-encrypted-required' : 'cicd-guide-encrypted-detected') }}
        </span>
      </div>
      <fieldset v-if="product === 'builder'" class="flex flex-wrap items-center gap-3 pt-1" data-test="cicd-platforms">
        <legend class="sr-only">
          {{ t('cicd-guide-platforms') }}
        </legend>
        <span class="text-sm font-medium text-slate-700 dark:text-slate-200" aria-hidden="true">{{ t('cicd-guide-platforms') }}</span>
        <label
          v-for="platform in CI_PLATFORMS"
          :key="platform"
          class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium text-slate-800 dark:text-slate-100"
          :class="choiceClass(platforms.includes(platform))"
        >
          <input type="checkbox" class="d-checkbox d-checkbox-sm" :checked="platforms.includes(platform)" :data-test="`cicd-platform-${platform}`" @change="togglePlatform(platform, $event)">
          <IconApple v-if="platform === 'ios'" class="h-5 w-5" aria-hidden="true" />
          <IconAndroid v-else class="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          {{ t(`cicd-guide-platform-${platform}`) }}
        </label>
      </fieldset>
    </section>

    <section aria-labelledby="cicd-question-strategy" class="space-y-3">
      <h2 id="cicd-question-strategy" class="text-lg font-semibold text-slate-950 dark:text-white">
        <span class="mr-2 text-slate-400" aria-hidden="true">1.</span>{{ t('cicd-guide-question-strategy') }}
      </h2>
      <fieldset class="min-w-0 grid gap-3 md:grid-cols-3" aria-labelledby="cicd-question-strategy">
        <button
          v-for="option in CI_STRATEGIES"
          :key="option"
          type="button"
          :aria-pressed="strategy === option"
          class="flex min-h-28 flex-col items-start rounded-2xl border p-5 text-left shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
          :class="choiceClass(strategy === option)"
          :data-test="`cicd-strategy-${option}`"
          @click="strategy = option"
        >
          <span class="flex w-full items-center gap-3">
            <component :is="strategyIcons[option]" class="h-5 w-5 shrink-0 text-primary-500 dark:text-azure-300" aria-hidden="true" />
            <span class="min-w-0 flex-1 text-base font-semibold text-slate-950 dark:text-white">{{ t(`cicd-guide-strategy-${option}`, strategyParams) }}</span>
            <IconCheck v-if="strategy === option" class="h-5 w-5 shrink-0 text-azure-500" aria-hidden="true" />
          </span>
          <span class="mt-2 block text-sm leading-6 text-slate-600 dark:text-slate-300">{{ t(`cicd-guide-strategy-${product}-${option}-description`, strategyParams) }}</span>
        </button>
      </fieldset>
      <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        <label class="block">
          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('cicd-guide-production-branch') }}</span>
          <input v-model="productionBranchInput" type="text" class="d-input mt-1 h-11 w-full rounded-lg border-slate-300 bg-white font-mono text-sm dark:border-white/20 dark:bg-slate-900" spellcheck="false" autocomplete="off" data-test="cicd-production-branch" :aria-invalid="productionBranchInvalid">
          <span v-if="productionBranchInvalid" class="mt-1 block text-xs text-amber-700 dark:text-amber-400">{{ t('cicd-guide-branch-invalid', { branch: productionBranch }) }}</span>
        </label>
        <label v-if="strategy === 'main_preprod'" class="block">
          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('cicd-guide-preprod-branch') }}</span>
          <input v-model="preprodBranchInput" type="text" class="d-input mt-1 h-11 w-full rounded-lg border-slate-300 bg-white font-mono text-sm dark:border-white/20 dark:bg-slate-900" spellcheck="false" autocomplete="off" data-test="cicd-preprod-branch" :aria-invalid="preprodBranchInvalid">
          <span v-if="branchesEqual" class="mt-1 block text-xs text-amber-700 dark:text-amber-400" data-test="cicd-branches-equal">{{ t('cicd-guide-branches-equal') }}</span>
          <span v-else-if="preprodBranchInvalid" class="mt-1 block text-xs text-amber-700 dark:text-amber-400">{{ t('cicd-guide-branch-invalid', { branch: preprodBranch }) }}</span>
        </label>
        <label v-if="showTesterChannel" class="block">
          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('cicd-guide-tester-channel') }}</span>
          <input v-model="preprodChannel" type="text" class="d-input mt-1 h-11 w-full rounded-lg border-slate-300 bg-white font-mono text-sm dark:border-white/20 dark:bg-slate-900" spellcheck="false" autocomplete="off" data-test="cicd-preprod-channel" :aria-invalid="testerChannelInvalid || testerChannelCollision">
          <span v-if="testerChannelCollision" class="mt-1 block text-xs text-red-700 dark:text-red-400" data-test="cicd-tester-channel-collision">{{ t('cicd-guide-tester-channel-collision') }}</span>
          <span v-else-if="testerChannelInvalid" class="mt-1 block text-xs text-red-700 dark:text-red-400">{{ t('cicd-guide-tester-channel-invalid') }}</span>
        </label>
      </div>
    </section>

    <section aria-labelledby="cicd-question-provider" class="space-y-3">
      <h2 id="cicd-question-provider" class="text-lg font-semibold text-slate-950 dark:text-white">
        <span class="mr-2 text-slate-400" aria-hidden="true">2.</span>{{ t('cicd-guide-question-provider') }}
      </h2>
      <fieldset class="min-w-0 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-labelledby="cicd-question-provider">
        <button
          v-for="option in CI_PROVIDERS"
          :key="option"
          type="button"
          :aria-pressed="provider === option"
          class="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl border px-3 py-4 text-center shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
          :class="choiceClass(provider === option)"
          :data-test="`cicd-provider-${option}`"
          @click="provider = option"
        >
          <component :is="providerIcons[option]" class="h-7 w-7 text-slate-800 dark:text-slate-100" aria-hidden="true" />
          <span class="text-sm font-medium leading-5 text-slate-900 dark:text-white">{{ t(`cicd-guide-provider-${option}`) }}</span>
        </button>
      </fieldset>
      <output v-if="provider && channelUnsupported" class="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200" data-test="cicd-channel-unsupported">
        <IconTriangleAlert class="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          {{ t('cicd-guide-channel-unsupported', { channel: unsupportedChannel }) }}
          <RouterLink :to="`/app/${encodeURIComponent(appId)}/channels`" class="ml-1 font-medium underline underline-offset-4">{{ t('cicd-guide-open-channels') }}</RouterLink>
        </span>
      </output>
      <p v-if="!provider" class="rounded-2xl border border-dashed border-slate-300 px-6 py-5 text-center text-sm text-slate-500 dark:border-white/15 dark:text-slate-400" data-test="cicd-choose-provider">
        {{ t('cicd-guide-choose-provider') }}
      </p>
    </section>

    <div v-if="provider && product === 'ota' && (channelStatus !== 'ready' || encryptionStatus !== 'ready')" class="space-y-3" aria-live="polite" data-test="cicd-settings-status">
      <template v-for="setting in (['channels', 'encryption'] as const)" :key="setting">
        <div v-if="(setting === 'channels' ? channelStatus : encryptionStatus) !== 'ready'" class="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 dark:border-white/15 dark:bg-slate-900 dark:text-slate-200" :data-test="`cicd-${setting}-status`">
          <span class="min-w-0 flex-1">{{ t((setting === 'channels' ? channelStatus : encryptionStatus) === 'error' ? `cicd-guide-${setting}-error` : 'cicd-guide-settings-loading') }}</span>
          <button v-if="(setting === 'channels' ? channelStatus : encryptionStatus) === 'error'" type="button" :class="secondaryLinkClass" :data-test="`cicd-${setting}-retry`" @click="setting === 'channels' ? loadDefaultChannel() : loadEncryptionState()">
            <IconRefresh class="h-4 w-4" aria-hidden="true" />
            {{ t('cicd-guide-refresh') }}
          </button>
        </div>
      </template>
    </div>

    <section v-if="product === 'ota' && channelStatus === 'ready' && defaultChannels === null" class="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200" data-test="cicd-no-default-channel" aria-labelledby="cicd-production-target-title">
      <h2 id="cicd-production-target-title" class="font-semibold">
        {{ t('cicd-guide-production-target-title') }}
      </h2>
      <p>{{ t('cicd-guide-no-default-channel') }}</p>
      <label v-if="availableChannels.length" class="block">
        <span class="font-medium">{{ t('cicd-guide-production-target') }}</span>
        <select v-model="selectedProductionChannel" class="d-select mt-1 w-full rounded-lg border-slate-300 bg-white text-slate-950 dark:border-white/20 dark:bg-slate-900 dark:text-white" data-test="cicd-production-target">
          <option value="">{{ t('cicd-guide-production-target-select') }}</option>
          <option v-for="channel in availableChannels" :key="channel" :value="channel">{{ channel }}</option>
        </select>
      </label>
      <p v-else>
        {{ t('cicd-guide-production-target-create') }}
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <RouterLink :to="`/app/${encodeURIComponent(appId)}/channels`" class="font-medium underline underline-offset-4">
          {{ t('cicd-guide-open-channels') }}
        </RouterLink>
        <button type="button" :class="secondaryLinkClass" data-test="cicd-targets-refresh" @click="loadDefaultChannel()">
          <IconRefresh class="h-4 w-4" aria-hidden="true" />
          {{ t('cicd-guide-refresh') }}
        </button>
      </div>
    </section>

    <section v-if="provider && pipeline" aria-labelledby="cicd-steps-title" class="space-y-4" data-test="cicd-steps">
      <div>
        <h2 id="cicd-steps-title" class="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">
          {{ t('cicd-guide-steps-title', { provider: providerName }) }}
        </h2>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ t('cicd-guide-steps-subtitle') }}
        </p>
      </div>

      <ol class="space-y-4">
        <li v-if="product === 'builder'" class="flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900" data-test="cicd-step-credentials">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-500 text-sm font-semibold text-white dark:bg-azure-500" aria-hidden="true">
            {{ stepNumber('credentials') }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('cicd-guide-step-label', { number: stepNumber('credentials') }) }}
            </p>
            <h3 class="mt-1 text-lg font-semibold text-slate-950 dark:text-white">
              {{ t('cicd-guide-step-credentials-title') }}
            </h3>
            <p class="mt-2 max-w-prose text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('cicd-guide-step-credentials-description') }}
            </p>
            <div class="mt-3 space-y-2">
              <button
                v-for="platform in platforms"
                :key="platform"
                type="button"
                :class="commandClass"
                :aria-label="`${t('copy')}: ${builderCredentialsPushCommand(appId, platform)}`"
                @click="copy(builderCredentialsPushCommand(appId, platform), 'onboarding_cicd_credentials_copied')"
              >
                <code class="min-w-0 break-all font-mono text-sm leading-6 text-sky-200">{{ builderCredentialsPushCommand(appId, platform) }}</code>
                <IconCopy class="h-4 w-4 shrink-0 text-slate-400 group-hover:text-white" aria-hidden="true" />
              </button>
            </div>
            <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">
              {{ t('cicd-guide-step-credentials-missing') }}
              <RouterLink :to="checklistPath" class="font-medium text-sky-700 underline-offset-4 hover:underline dark:text-azure-300">
                {{ t('cicd-guide-open-checklist') }}
              </RouterLink>
            </p>
          </div>
        </li>

        <li class="flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900" data-test="cicd-step-key">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-500 text-sm font-semibold text-white dark:bg-azure-500" aria-hidden="true">
            {{ stepNumber('key') }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('cicd-guide-step-label', { number: stepNumber('key') }) }}
            </p>
            <h3 class="mt-1 text-lg font-semibold text-slate-950 dark:text-white">
              {{ t(pipeline.keys.length > 1 ? 'cicd-guide-step-keys-title' : 'cicd-guide-step-key-title') }}
            </h3>
            <p class="mt-2 max-w-prose text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('cicd-guide-step-key-description', { appId }) }}
            </p>
            <div class="mt-4 grid gap-3" :class="{ 'lg:grid-cols-2': pipeline.keys.length > 1 }">
              <div v-for="spec in pipeline.keys" :key="spec.secret" class="rounded-xl border border-slate-200 p-4 dark:border-white/15" :data-test="`cicd-key-${spec.secret}`">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <IconKey class="h-4 w-4 shrink-0 text-primary-500 dark:text-azure-300" aria-hidden="true" />
                  <code class="text-sm font-semibold text-slate-950 dark:text-white">{{ spec.secret }}</code>
                  <span v-if="pipeline.keys.length > 1" class="text-sm text-slate-500 dark:text-slate-400">{{ t(spec.purpose === 'preview' ? 'cicd-guide-key-preview' : 'cicd-guide-key-release') }}</span>
                  <span class="ml-auto rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-white/10 dark:text-slate-200">{{ t('cicd-guide-key-role', { role: t(roleLabels[spec.role]) }) }}</span>
                </div>
                <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {{ t(spec.purpose === 'preview' && spec.role === 'app_admin' ? 'cicd-guide-key-why-app_admin-preview' : `cicd-guide-key-why-${spec.role}`, { channel: preprodChannel }) }}
                </p>
                <template v-if="createdKeys[keySlot(spec)]">
                  <button type="button" class="mt-3" :class="[commandClass]" :aria-label="t('cicd-guide-key-copy')" :data-test="`cicd-key-value-${spec.secret}`" @click="copy(createdKeys[keySlot(spec)]!, 'onboarding_cicd_key_copied')">
                    <code class="min-w-0 break-all font-mono text-sm leading-6 text-sky-200">{{ createdKeys[keySlot(spec)] }}</code>
                    <IconCopy class="h-4 w-4 shrink-0 text-slate-400 group-hover:text-white" aria-hidden="true" />
                  </button>
                  <output class="mt-2 flex items-start gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                    <IconTriangleAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {{ t('cicd-guide-key-created') }}
                  </output>
                </template>
                <button
                  v-else
                  type="button"
                  class="d-btn d-btn-primary mt-3 min-h-11 px-4 text-sm"
                  :disabled="creatingKey[keySlot(spec)]"
                  :data-test="`cicd-create-key-${spec.secret}`"
                  @click="createKey(spec)"
                >
                  <IconLoader v-if="creatingKey[keySlot(spec)]" class="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                  <IconKey v-else class="h-4 w-4" aria-hidden="true" />
                  {{ creatingKey[keySlot(spec)] ? t('cicd-guide-key-creating') : t('cicd-guide-key-create', { secret: spec.secret }) }}
                </button>
                <div v-if="keyRegistrations[keySlot(spec)]?.status === 'error'" class="mt-3 text-sm text-amber-700 dark:text-amber-400" :data-test="`cicd-key-registration-error-${spec.secret}`">
                  <p role="alert">
                    {{ t('cicd-guide-key-registration-error') }}
                  </p>
                  <button type="button" :class="secondaryLinkClass" class="mt-2" :data-test="`cicd-key-registration-retry-${spec.secret}`" @click="recordCreatedKey(spec)">
                    <IconRefresh class="h-4 w-4" aria-hidden="true" />
                    {{ t('cicd-guide-key-registration-retry') }}
                  </button>
                </div>
                <p v-if="keyErrors[keySlot(spec)]" class="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">
                  {{ t(keyErrors[keySlot(spec)] === 'permission' ? 'cicd-guide-key-error-permission' : 'cicd-guide-key-error') }}
                </p>
              </div>
            </div>
            <RouterLink to="/settings/organization/api-keys" :class="secondaryLinkClass" class="mt-3">
              {{ t('cicd-guide-manage-keys') }}
              <IconArrowRight class="h-4 w-4" aria-hidden="true" />
            </RouterLink>
          </div>
        </li>

        <li class="flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900" data-test="cicd-step-secret">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-500 text-sm font-semibold text-white dark:bg-azure-500" aria-hidden="true">
            {{ stepNumber('secret') }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('cicd-guide-step-label', { number: stepNumber('secret') }) }}
            </p>
            <h3 class="mt-1 text-lg font-semibold text-slate-950 dark:text-white">
              {{ t(pipeline.keys.length > 1 ? 'cicd-guide-step-secrets-title' : 'cicd-guide-step-secret-title', { provider: providerName }) }}
            </h3>
            <ol class="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-700 marker:text-slate-400 dark:text-slate-200">
              <li v-if="provider !== 'other'">
                {{ t(provider === 'github' && protectedPreview ? 'cicd-guide-secret-github-builder-1' : `cicd-guide-secret-${provider}-1`, { previewScope }) }}
              </li>
              <li v-for="spec in pipeline.keys" :key="spec.secret">
                {{ t(secretInstruction(spec), { secret: spec.secret, scope: keyScope(spec) }) }}
              </li>
              <li v-if="provider === 'github'">
                {{ t('cicd-guide-secret-github-protect', { branches: releaseBranches.join(', ') }) }}
              </li>
              <li v-if="pipeline.extraSecrets.length" data-test="cicd-encryption-secret">
                {{ t('cicd-guide-secret-encryption', { secret: CI_ENCRYPTION_SECRET }) }}
                <button type="button" class="mt-2" :class="commandClass" :aria-label="`${t('copy')}: ${encryptionSecretCommand(provider === 'github' ? 'github' : 'other')}`" @click="copy(encryptionSecretCommand(provider === 'github' ? 'github' : 'other'))">
                  <code class="min-w-0 break-all font-mono text-sm leading-6 text-sky-200">{{ encryptionSecretCommand(provider === 'github' ? 'github' : 'other') }}</code>
                  <IconCopy class="h-4 w-4 shrink-0 text-slate-400 group-hover:text-white" aria-hidden="true" />
                </button>
                <button v-if="provider === 'github' && strategy === 'pull_request'" type="button" class="mt-2" :class="commandClass" :aria-label="`${t('copy')}: ${encryptionSecretCommand('github', 'preview')}`" @click="copy(encryptionSecretCommand('github', 'preview'))">
                  <code class="min-w-0 break-all font-mono text-sm leading-6 text-sky-200">{{ encryptionSecretCommand('github', 'preview') }}</code>
                  <IconCopy class="h-4 w-4 shrink-0 text-slate-400 group-hover:text-white" aria-hidden="true" />
                </button>
                <p v-if="provider === 'github' && strategy === 'pull_request'" class="mt-2">
                  {{ t('cicd-guide-secret-github-encryption', { secret: CI_ENCRYPTION_SECRET, scope: previewScope }) }}
                </p>
              </li>
              <template v-if="provider === 'gitlab'">
                <li>{{ t('cicd-guide-secret-gitlab-protect', { branch: productionBranch }) }}</li>
                <li v-if="strategy === 'main_preprod'">
                  {{ t('cicd-guide-secret-gitlab-protect-preprod', { branch: preprodBranch }) }}
                </li>
                <li v-if="product === 'ota' && !encryptedPreview && pipeline.keys.some(spec => spec.secret === 'CAPGO_PREVIEW_TOKEN')">
                  {{ t('cicd-guide-secret-gitlab-preview') }}
                </li>
                <li v-if="pipeline.extraSecrets.length && strategy === 'pull_request'">
                  {{ t('cicd-guide-secret-gitlab-preview-encryption', { secret: CI_ENCRYPTION_SECRET, scope: previewScope }) }}
                </li>
              </template>
              <template v-if="provider === 'azure'">
                <li>{{ t('cicd-guide-secret-azure-protect', { branches: releaseBranchRefs }) }}</li>
                <li>{{ t('cicd-guide-secret-azure-permit') }}</li>
              </template>
              <li v-if="provider === 'bitbucket'">
                {{ t('cicd-guide-secret-bitbucket-protect', { branches: releaseBranches.join(', ') }) }}
              </li>
              <li v-if="provider === 'circleci'">
                {{ t('cicd-guide-secret-circleci-protect', { expression: circleReleaseExpression }) }}
              </li>
              <li v-if="pipeline.extraSecrets.length && strategy === 'pull_request' && (provider === 'azure' || provider === 'bitbucket' || provider === 'circleci')">
                {{ t('cicd-guide-secret-encryption-scopes', { secret: CI_ENCRYPTION_SECRET, scope: previewScope }) }}
              </li>
            </ol>
            <div v-if="protectedPreview" class="mt-4 space-y-2 rounded-xl border border-slate-200 p-4 text-sm leading-6 text-slate-700 dark:border-white/15 dark:text-slate-200" :data-test="builderPreview ? 'cicd-builder-preview-trust' : 'cicd-encrypted-preview-trust'">
              <h4 class="font-semibold text-slate-950 dark:text-white">
                {{ t(encryptedPreview ? 'cicd-guide-encrypted-preview-trust-title' : 'cicd-guide-builder-preview-trust-title') }}
              </h4>
              <p>{{ t(encryptedPreview ? 'cicd-guide-encrypted-preview-trust' : 'cicd-guide-builder-preview-trust') }}</p>
              <ol class="list-decimal space-y-2 pl-5">
                <li>{{ t(`cicd-guide-${encryptedPreview ? 'encrypted' : 'builder'}-preview-${provider}`, { scope: previewScope, branch: productionBranch }) }}</li>
                <li v-if="provider === 'gitlab'">
                  {{ t(encryptedPreview ? 'cicd-guide-encrypted-preview-gitlab-run' : 'cicd-guide-builder-preview-gitlab-run', { branch: productionBranch }) }}
                </li>
                <li>{{ t(encryptedPreview ? 'cicd-guide-encrypted-preview-fallback' : 'cicd-guide-builder-preview-fallback') }}</li>
              </ol>
            </div>
            <template v-if="provider === 'github'">
              <p class="mt-3 text-sm text-slate-600 dark:text-slate-300">
                {{ t('cicd-guide-secret-github-cli') }}
              </p>
              <div class="mt-2 space-y-2">
                <button
                  v-for="spec in pipeline.keys"
                  :key="spec.secret"
                  type="button"
                  :class="commandClass"
                  :aria-label="`${t('copy')}: ${githubSecretCommand(spec.secret, spec.purpose, product, encrypted)}`"
                  @click="copy(githubSecretCommand(spec.secret, spec.purpose, product, encrypted))"
                >
                  <code class="min-w-0 break-all font-mono text-sm leading-6 text-sky-200">{{ githubSecretCommand(spec.secret, spec.purpose, product, encrypted) }}</code>
                  <IconCopy class="h-4 w-4 shrink-0 text-slate-400 group-hover:text-white" aria-hidden="true" />
                </button>
              </div>
            </template>
            <p v-if="provider === 'other'" class="mt-3 flex items-start gap-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              <IconInfo class="mt-0.5 h-4 w-4 shrink-0 text-azure-500" aria-hidden="true" />
              {{ t('cicd-guide-secret-other-note') }}
            </p>
          </div>
        </li>

        <li class="flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900" data-test="cicd-step-file">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-500 text-sm font-semibold text-white dark:bg-azure-500" aria-hidden="true">
            {{ stepNumber('file') }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('cicd-guide-step-label', { number: stepNumber('file') }) }}
            </p>
            <h3 class="mt-1 text-lg font-semibold text-slate-950 dark:text-white">
              {{ t(pipeline.file ? 'cicd-guide-step-file-title' : 'cicd-guide-step-file-title-other') }}
            </h3>
            <p class="mt-2 max-w-prose text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t(provider === 'other' ? 'cicd-guide-step-file-description-other' : provider === 'gitlab' ? 'cicd-guide-step-file-description-gitlab' : 'cicd-guide-step-file-description') }}
            </p>
            <div class="mt-3 overflow-hidden rounded-xl bg-slate-950" data-test="cicd-pipeline">
              <div class="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
                <span class="flex min-w-0 items-center gap-2 text-sm text-slate-300">
                  <IconFileText class="h-4 w-4 shrink-0" aria-hidden="true" />
                  <code class="break-all" data-test="cicd-pipeline-file">{{ pipeline.file ?? 'shell' }}</code>
                </span>
                <button type="button" class="d-btn d-btn-sm min-h-9 shrink-0 border-white/15 bg-white/10 text-sm text-white hover:border-white/25 hover:bg-white/20" :aria-label="t(pipeline.file ? 'cicd-guide-copy-file' : 'cicd-guide-copy-commands')" data-test="cicd-copy-pipeline" @click="copy(pipeline.content, 'onboarding_cicd_pipeline_copied')">
                  <IconCopy class="h-4 w-4" aria-hidden="true" />
                  <span class="hidden sm:inline" aria-hidden="true">{{ t(pipeline.file ? 'cicd-guide-copy-file' : 'cicd-guide-copy-commands') }}</span>
                </button>
              </div>
              <pre class="max-h-[28rem] overflow-auto p-4 text-[13px] leading-6 text-sky-100"><code data-test="cicd-pipeline-content">{{ pipeline.content }}</code></pre>
            </div>
            <ul class="mt-4 space-y-2 text-sm leading-6 text-slate-600 dark:text-slate-300" data-test="cicd-notes">
              <li v-if="provider === 'azure'" class="flex items-start gap-2">
                <IconArrowRight class="mt-1 h-4 w-4 shrink-0 text-azure-500" aria-hidden="true" />
                {{ t('cicd-guide-file-azure-pipeline') }}
              </li>
              <li v-if="provider === 'azure' && strategy === 'pull_request'" class="flex items-start gap-2">
                <IconArrowRight class="mt-1 h-4 w-4 shrink-0 text-azure-500" aria-hidden="true" />
                {{ t('cicd-guide-file-azure-pr', { branch: productionBranch }) }}
              </li>
              <li v-if="provider === 'circleci'" class="flex items-start gap-2">
                <IconArrowRight class="mt-1 h-4 w-4 shrink-0 text-azure-500" aria-hidden="true" />
                {{ t('cicd-guide-file-circleci-project') }}
              </li>
              <template v-if="product === 'ota'">
                <li class="flex items-start gap-2">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t(provider === 'github' && strategy === 'pull_request' ? 'cicd-guide-note-github-preview-version' : 'cicd-guide-note-version') }}
                </li>
                <li class="flex items-start gap-2">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t('cicd-guide-note-incompatible') }}
                </li>
                <li v-if="encrypted" class="flex items-start gap-2" data-test="cicd-note-encryption">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t('cicd-guide-note-encryption', { secret: CI_ENCRYPTION_SECRET }) }}
                </li>
              </template>
              <template v-else>
                <li class="flex items-start gap-2">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t('cicd-guide-note-stored-credentials') }}
                </li>
                <li v-if="strategy === 'main_preprod'" class="flex items-start gap-2">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t('cicd-guide-note-store-review', { branch: productionBranch }) }}
                </li>
                <li v-if="strategy !== 'main'" class="flex items-start gap-2" data-test="cicd-note-tester-builds">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t('cicd-guide-note-tester-builds') }}
                </li>
              </template>
              <template v-if="strategy === 'pull_request'">
                <li v-if="provider === 'github'" class="flex items-start gap-2">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t('cicd-guide-note-forks') }}
                </li>
                <li v-if="product === 'ota' && pipeline.cleansUpPreviews" class="flex items-start gap-2" data-test="cicd-note-cleanup">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {{ t(provider === 'github' && encryptedPreview ? 'cicd-guide-note-cleanup-approval' : 'cicd-guide-note-cleanup-auto', { scope: previewScope }) }}
                </li>
                <li v-else-if="product === 'ota'" class="flex items-start gap-2" data-test="cicd-note-cleanup-manual">
                  <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  <span class="min-w-0 flex-1">
                    {{ t('cicd-guide-note-cleanup-manual', { provider: providerName }) }}
                    <code class="mt-1 block break-all rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-800 dark:bg-white/10 dark:text-slate-100">{{ previewCleanupCommand(appId) }}</code>
                  </span>
                </li>
              </template>
              <li class="flex items-start gap-2">
                <IconInfo class="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                {{ t('cicd-guide-note-package-manager') }}
              </li>
            </ul>
          </div>
        </li>

        <li class="flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900" data-test="cicd-step-verify">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-500 text-sm font-semibold text-white dark:bg-azure-500" aria-hidden="true">
            {{ stepNumber('verify') }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('cicd-guide-step-label', { number: stepNumber('verify') }) }}
            </p>
            <h3 class="mt-1 text-lg font-semibold text-slate-950 dark:text-white">
              {{ t('cicd-guide-step-verify-title') }}
            </h3>
            <p class="mt-2 max-w-prose text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t(product === 'ota' ? 'cicd-guide-step-verify-ota' : 'cicd-guide-step-verify-builder', { branch: productionBranch, channel: productionChannel }) }}
            </p>
            <p v-if="strategy === 'pull_request'" class="mt-2 max-w-prose text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t(product === 'ota' ? 'cicd-guide-step-verify-preview-ota' : 'cicd-guide-step-verify-preview-builder') }}
            </p>
            <output class="mt-4 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm" :class="detectedAt ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'bg-slate-50 dark:bg-slate-950/60'" aria-live="polite" data-test="cicd-detection">
              <IconCheck v-if="detectedAt" class="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              <IconTriangleAlert v-else-if="statusError" class="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <IconLoader v-else class="h-4 w-4 shrink-0 text-slate-400 motion-safe:animate-spin" aria-hidden="true" />
              <span class="min-w-0 flex-1 text-slate-700 dark:text-slate-200">
                <template v-if="detectedAt">{{ detectedLabel }}</template>
                <template v-else-if="statusError">{{ t('cicd-guide-status-error') }}</template>
                <template v-else>{{ t(product === 'ota' ? 'cicd-guide-waiting-ota' : 'cicd-guide-waiting-builder') }}</template>
              </span>
              <button v-if="!detectedAt" type="button" class="d-btn d-btn-ghost d-btn-sm min-h-9 text-sky-700 dark:text-azure-300" :disabled="statusLoading" data-test="cicd-detection-refresh" @click="refreshStatus">
                <IconRefresh class="h-4 w-4" :class="{ 'motion-safe:animate-spin': statusLoading }" aria-hidden="true" />
                {{ t('cicd-guide-refresh') }}
              </button>
            </output>
            <div class="mt-3 flex flex-wrap gap-2">
              <RouterLink :to="`/app/${encodeURIComponent(appId)}/${product === 'ota' ? 'bundles' : 'builds'}`" :class="secondaryLinkClass">
                {{ t(product === 'ota' ? 'cicd-guide-open-bundles' : 'cicd-guide-open-builds') }}
                <IconArrowRight class="h-4 w-4" aria-hidden="true" />
              </RouterLink>
              <a :href="docsHref" target="_blank" rel="noopener noreferrer" :class="secondaryLinkClass" data-test="cicd-docs">
                <IconFileText class="h-4 w-4" aria-hidden="true" />
                {{ t('cicd-guide-docs') }}
              </a>
            </div>
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>
