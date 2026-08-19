<script setup lang="ts">
import type { Ref } from 'vue'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { sendEvent } from '~/services/tracking'
import { useOrganizationStore } from '~/stores/organization'

type DemoStep = 1 | 2 | 3
type PhoneStage = 'hidden' | 'installing' | 'home' | 'launching' | 'app'
interface StepMeta {
  id: DemoStep
  label: string
  caption: string
}

interface StepContent {
  title: string
  description: string
  terminalIdle: string
  terminalDone: string
}

interface AppChoice {
  id: string
  name: string
  icon: string
  iconBg: string
  iconColor: string
}

interface SpringboardApp {
  id: string
  name: string
  icon: string
  iconBg: string
  iconColor: string
  isDemo?: boolean
}

interface UpdateChoice {
  id: 'confetti' | 'bg-color' | 'title'
  label: string
  result: string
  command: string
  terminalLine: string
}

interface ConfettiPiece {
  id: number
  left: number
  duration: number
  delay: number
  color: string
}

interface TimedTerminalLine {
  line: string
  delay: number
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const organizationStore = useOrganizationStore()
const CAPGO_CLI_COMMAND = 'bunx @capgo/cli@latest'

const appChoices: AppChoice[] = [
  {
    id: 'pulse-pro',
    name: 'Pulse Pro',
    icon: '⚡',
    iconBg: '#e0e7ff',
    iconColor: '#4338ca',
  },
  {
    id: 'nova-reader',
    name: 'Nova Reader',
    icon: '👟',
    iconBg: '#dbeafe',
    iconColor: '#1d4ed8',
  },
  {
    id: 'orbit-notes',
    name: 'Orbit Notes',
    icon: '🗂️',
    iconBg: '#ccfbf1',
    iconColor: '#0f766e',
  },
]
const customAppChoice = ref<AppChoice | null>(null)

const fakeSpringboardApps: SpringboardApp[] = [
  { id: 'mail', name: 'Mail', icon: '✉️', iconBg: '#dbeafe', iconColor: '#1d4ed8' },
  { id: 'maps', name: 'Maps', icon: '🗺️', iconBg: '#dcfce7', iconColor: '#166534' },
  { id: 'music', name: 'Music', icon: '🎵', iconBg: '#fce7f3', iconColor: '#be185d' },
  { id: 'camera', name: 'Camera', icon: '📷', iconBg: '#e2e8f0', iconColor: '#334155' },
  { id: 'notes', name: 'Notes', icon: '📝', iconBg: '#fef9c3', iconColor: '#a16207' },
  { id: 'clock', name: 'Clock', icon: '🕒', iconBg: '#f1f5f9', iconColor: '#0f172a' },
  { id: 'chat', name: 'Chat', icon: '💬', iconBg: '#d1fae5', iconColor: '#047857' },
  { id: 'news', name: 'News', icon: '📰', iconBg: '#dbeafe', iconColor: '#1e3a8a' },
  { id: 'photos', name: 'Photos', icon: '🖼️', iconBg: '#ffedd5', iconColor: '#c2410c' },
  { id: 'health', name: 'Health', icon: '❤️', iconBg: '#fee2e2', iconColor: '#dc2626' },
  { id: 'wallet', name: 'Wallet', icon: '💳', iconBg: '#e2e8f0', iconColor: '#475569' },
]

const fakeDockApps: SpringboardApp[] = [
  { id: 'phone', name: 'Phone', icon: '📞', iconBg: '#dcfce7', iconColor: '#166534' },
  { id: 'safari', name: 'Safari', icon: '🌐', iconBg: '#dbeafe', iconColor: '#1d4ed8' },
  { id: 'messages', name: 'SMS', icon: '💬', iconBg: '#dcfce7', iconColor: '#15803d' },
]

const onboardingSteps: StepMeta[] = [
  { id: 1, label: 'Create app', caption: 'Generate your app ID' },
  { id: 2, label: 'Install + Update', caption: 'Push first update' },
  { id: 3, label: 'Test', caption: 'Verify on phone' },
]

function randomUnit() {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] / 0x100000000
}

const stepContentMap: Record<DemoStep, StepContent> = {
  1: {
    title: '1. Create an app',
    description: 'Type your app name to see how the Capgo flow works.',
    terminalIdle: 'Type your app name above to start.',
    terminalDone: 'App ready on device',
  },
  2: {
    title: '2. Publish a first update',
    description: 'Select one update action. The terminal starts a fake upload and the update then flows to the phone.',
    terminalIdle: 'Waiting for action...',
    terminalDone: 'Upload complete',
  },
  3: {
    title: '3. Open the app again',
    description: 'Your update reached the device. Press Home, then open your app from the app list to see the new version load.',
    terminalIdle: 'Waiting for action...',
    terminalDone: 'Upload complete',
  },
}

const updateChoices: UpdateChoice[] = [
  {
    id: 'confetti',
    label: 'Make confetti',
    result: 'Basic (confetti mode)',
    command: `${CAPGO_CLI_COMMAND} bundle upload <appId> --path ./dist --channel production --comment "Confetti demo payload"`,
    terminalLine: 'Uploading bundle metadata and assets',
  },
  {
    id: 'bg-color',
    label: 'Change the background color',
    result: 'Basic (color refresh)',
    command: `${CAPGO_CLI_COMMAND} bundle upload <appId> --path ./dist --channel production --comment "Background color demo payload"`,
    terminalLine: 'Preparing release bundle for distribution',
  },
  {
    id: 'title',
    label: 'Change the title',
    result: 'Welcome back to Capgo',
    command: `${CAPGO_CLI_COMMAND} bundle upload <appId> --path ./dist --channel production --comment "Title change demo payload"`,
    terminalLine: 'Publishing updated bundle metadata',
  },
]

const appName = ref('')
const selectedAppId = ref('')
const installedAppId = ref('')
const step = ref<DemoStep>(1)
const selectedAction = ref<UpdateChoice | null>(null)
const isCreatingApp = ref(false)
const isUploading = ref(false)
const uploadLines = ref<string[]>([])
const createLines = ref<string[]>([])
const isUploadComplete = ref(false)
const phoneTheme = ref<'default' | 'warm'>('default')
const phoneStage = ref<PhoneStage>('hidden')
const hasOpenedUpdatedApp = ref(false)
const transferPosition = ref(0)
const transferTimer = ref<number | null>(null)
const uploadTimer = ref<number | null>(null)
const createTimer = ref<number | null>(null)
const confettiTimer = ref<number | null>(null)
const timers = ref<number[]>([])

function trackNoAppDemoEvent(event: string, tags: Record<string, string | number | boolean> = {}) {
  const orgId = organizationStore.currentOrganization?.gid
  if (orgId) {
    sendEvent({
      channel: 'demo-onboarding',
      event,
      icon: '🧪',
      org_id: orgId,
      tracking_version: 2,
      notify: false,
      tags,
    }).catch()
    sendOnboardingEvent(`user:${event}`, { org_id: orgId, ...tags })
  }
}

function trackNoAppDemoStepEvent(stepId: DemoStep | 'global', action: string, tags: Record<string, string | number | boolean> = {}) {
  const prefix = stepId === 'global' ? 'demo-onboarding-global' : `demo-onboarding-step-${stepId}`
  trackNoAppDemoEvent(`${prefix}-${action}`, tags)
}

const defaultDemoApp: SpringboardApp = {
  id: 'demo-app',
  name: 'Demo App',
  icon: '📱',
  iconBg: '#ede9fe',
  iconColor: '#6d28d9',
  isDemo: true,
}

const isCreateStep = computed(() => step.value === 1)
const isUploadStep = computed(() => step.value === 2)
const isPhoneInstalling = computed(() => phoneStage.value === 'installing')
const isBgColorUpdateApplied = computed(() => hasOpenedUpdatedApp.value && selectedAction.value?.id === 'bg-color')
const isTitleUpdateApplied = computed(() => hasOpenedUpdatedApp.value && selectedAction.value?.id === 'title')
const isConfettiUpdateApplied = computed(() => hasOpenedUpdatedApp.value && selectedAction.value?.id === 'confetti')
const showPhoneLauncher = computed(() => phoneStage.value === 'launching' || phoneStage.value === 'app')
const showPhoneHome = computed(() => phoneStage.value === 'home' || phoneStage.value === 'installing')
const showReopenButton = computed(() => !hasOpenedUpdatedApp.value && isUploadComplete.value && phoneStage.value === 'app')

const stepContent = computed(() => stepContentMap[step.value])
const stepTitle = computed(() => stepContent.value.title)
const stepDescription = computed(() => stepContent.value.description)

const availableAppChoices = computed(() => customAppChoice.value ? [customAppChoice.value, ...appChoices] : appChoices)
const selectedApp = computed(() => availableAppChoices.value.find(choice => choice.id === selectedAppId.value))
const installedApp = computed(() => availableAppChoices.value.find(choice => choice.id === installedAppId.value))
const springboardDemoApp = computed<SpringboardApp>(() => {
  if (!installedApp.value)
    return defaultDemoApp

  return {
    id: installedApp.value.id,
    name: installedApp.value.name,
    icon: installedApp.value.icon,
    iconBg: installedApp.value.iconBg,
    iconColor: installedApp.value.iconColor,
    isDemo: true,
  }
})
const springboardApps = computed(() => {
  return [springboardDemoApp.value, ...fakeSpringboardApps].slice(0, 12)
})
const springboardDockApps = computed(() => {
  return [springboardDemoApp.value, ...fakeDockApps].slice(0, 4)
})

const canContinueOnboarding = computed(() => {
  return !!installedAppId.value
})

function currentStepText(entryId: DemoStep) {
  if (entryId === step.value)
    return 'border-violet-300 bg-violet-50 text-violet-700 shadow-sm'
  if (entryId < step.value)
    return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  return 'border-base-200 bg-base-100 text-base-content/60'
}

const wireStyle = computed(() => ({
  left: `${Math.min(transferPosition.value, 96)}%`,
}))

const terminalLines = computed(() => {
  return isCreateStep.value ? createLines.value : uploadLines.value
})

const terminalLiveMessage = computed(() => {
  if (isCreateStep.value)
    return isCreatingApp.value ? 'Creating app in Capgo...' : ''
  if (isUploadStep.value)
    return isUploading.value ? 'Uploading to Capgo...' : ''
  return ''
})

const terminalIdleMessage = computed(() => stepContent.value.terminalIdle)
const terminalDoneMessage = computed(() => stepContent.value.terminalDone)

const transferDotClass = computed(() => {
  if (isUploading.value || isCreatingApp.value || isPhoneInstalling.value)
    return 'bg-cyan-500'
  if (transferPosition.value >= 100)
    return 'bg-emerald-500'
  return 'bg-slate-400'
})

const phoneBackgroundClass = computed(() => {
  if (phoneStage.value === 'app' && isBgColorUpdateApplied.value)
    return 'from-indigo-900 via-indigo-900 to-indigo-900'

  return phoneTheme.value === 'warm'
    ? 'from-sky-50 via-cyan-50 to-blue-100'
    : 'from-slate-100 to-slate-200'
})

const phoneStatusMessage = computed(() => {
  if (phoneStage.value === 'home')
    return 'Device is now on the home screen. Open the Demo App to apply the update.'
  if (phoneStage.value === 'launching')
    return 'Launching the app. Watch the splash screen flow.'
  if (!hasOpenedUpdatedApp.value)
    return 'Update is ready on the device. Background and reopen the app to apply it.'
  return 'Great, your app is now running the updated version.'
})

const selectedAppVisual = computed(() => selectedApp.value ?? springboardDemoApp.value)
const selectedActionResult = computed(() => selectedAction.value?.result ?? 'Basic')
const phoneAppTitle = computed(() => {
  if (isTitleUpdateApplied.value)
    return 'Welcome to Capgo!'
  return appName.value || 'Demo App'
})

const selectedAppIconStyle = computed(() => ({
  backgroundColor: selectedAppVisual.value.iconBg,
  color: selectedAppVisual.value.iconColor,
}))

function getSpringboardIconStyle(app: SpringboardApp) {
  if (app.isDemo && isPhoneInstalling.value)
    return { backgroundColor: '#e2e8f0', color: '#94a3b8' }
  return { backgroundColor: app.iconBg, color: app.iconColor }
}

function showSpringboardInstallOverlay(app: SpringboardApp) {
  return app.isDemo && isPhoneInstalling.value
}

function formatDemoAppId(name: string) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/g, '')
    .replace(/-$/g, '')

  return `com.demo.${slug}`
}

function getAddAppCommand(appId: string, name: string) {
  return `${CAPGO_CLI_COMMAND} app add ${appId} --name "${name}"`
}

function getUploadCommand(appId: string) {
  return `${CAPGO_CLI_COMMAND} bundle upload ${appId} --path ./dist --channel production`
}

function queueTerminalLines(linesRef: Ref<string[]>, entries: TimedTerminalLine[]) {
  entries.forEach(({ line, delay }) => {
    const timer = window.setTimeout(() => {
      linesRef.value.push(line)
    }, delay)
    timers.value.push(timer)
  })
}

function closeModal() {
  trackNoAppDemoStepEvent(step.value, 'closed', { step: step.value })
  emit('close')
  router.push('/app/new')
}

const showConfetti = ref(false)
const confettiPieces = ref<ConfettiPiece[]>([])

async function triggerConfetti(trackClickOrEvent: boolean | Event = true) {
  const trackClick = typeof trackClickOrEvent === 'boolean' ? trackClickOrEvent : true
  if (trackClick)
    trackNoAppDemoStepEvent(step.value, 'confetti-clicked', { step: step.value })
  if (confettiTimer.value !== null) {
    window.clearTimeout(confettiTimer.value)
    confettiTimer.value = null
  }
  confettiPieces.value = Array.from({ length: 48 }, (_, id) => ({
    id,
    left: randomUnit() * 100,
    duration: 0.9 + randomUnit() * 1.1,
    delay: randomUnit() * 0.22,
    color: `hsl(${Math.floor(randomUnit() * 360)}, 95%, 55%)`,
  }))
  showConfetti.value = false
  await nextTick()
  showConfetti.value = true
  confettiTimer.value = window.setTimeout(() => {
    showConfetti.value = false
    confettiTimer.value = null
  }, 2500)
}

function resetDemo() {
  appName.value = ''
  customAppChoice.value = null
  selectedAppId.value = ''
  installedAppId.value = ''
  step.value = 1
  selectedAction.value = null
  isCreatingApp.value = false
  isUploading.value = false
  isUploadComplete.value = false
  hasOpenedUpdatedApp.value = false
  phoneStage.value = 'home'
  phoneTheme.value = 'default'
  showConfetti.value = false
  confettiPieces.value = []
  createLines.value = []
  uploadLines.value = []
  transferPosition.value = 0
  clearAllTimers()
}

function restartApp() {
  if (!isUploadComplete.value)
    return

  trackNoAppDemoStepEvent(step.value, 'reopen-clicked', { step: step.value })
  phoneStage.value = 'home'
  const timer = window.setTimeout(() => {
    openAppFromPhoneHome(true)
  }, 800)
  timers.value.push(timer)
}

function openAppFromPhoneHome(markUpdated = false) {
  if (phoneStage.value !== 'home' || isUploading.value)
    return

  if (markUpdated)
    trackNoAppDemoStepEvent(step.value, 'updated-app-opened', { step: step.value })

  phoneStage.value = 'launching'
  if (!markUpdated && step.value === 1)
    step.value = 2
  const timer = window.setTimeout(() => {
    phoneStage.value = 'app'
    if (markUpdated)
      hasOpenedUpdatedApp.value = true
  }, 1200)
  timers.value.push(timer)
}

function submitAppName() {
  const name = appName.value.trim()
  if (!name || isCreatingApp.value)
    return
  const choice = {
    id: formatDemoAppId(name).replace(/\./g, '-'),
    name,
    icon: '📱',
    iconBg: '#ede9fe',
    iconColor: '#6d28d9',
  }
  customAppChoice.value = choice
  selectApp(choice)
}

function selectApp(choice: AppChoice) {
  trackNoAppDemoStepEvent(step.value, 'app-selected', {
    app_id: choice.id,
    app_name: choice.name,
    step: step.value,
  })
  appName.value = choice.name
  selectedAppId.value = choice.id
  const appId = formatDemoAppId(choice.name)
  isCreatingApp.value = true
  createLines.value = [`$ ${getAddAppCommand(appId, choice.name)}`]
  clearAllTimers()
  transferPosition.value = 0
  transferTimer.value = window.setInterval(() => {
    transferPosition.value = Math.min(transferPosition.value + 6, 100)
  }, 130)

  queueTerminalLines(createLines, [
    { line: '◆  Adding', delay: 400 },
    { line: `Adding ${appId} to Capgo`, delay: 900 },
    { line: `✔ App ${appId} added to Capgo`, delay: 1500 },
    { line: `Next step: upload a bundle with "npx @capgo/cli bundle upload"`, delay: 1800 },
  ])

  createTimer.value = window.setTimeout(() => {
    if (transferTimer.value !== null) {
      window.clearInterval(transferTimer.value)
      transferTimer.value = null
    }
    transferPosition.value = 100
    isCreatingApp.value = false
    installedAppId.value = choice.id
    phoneStage.value = 'installing'
    const launchTimer = window.setTimeout(() => {
      phoneStage.value = 'home'
      const autoOpenTimer = window.setTimeout(() => {
        openAppFromPhoneHome()
      }, 700)
      timers.value.push(autoOpenTimer)
    }, 900)
    timers.value.push(launchTimer)
  }, 2500)
}

function clearAllTimers() {
  if (createTimer.value !== null) {
    window.clearTimeout(createTimer.value)
    createTimer.value = null
  }

  if (transferTimer.value !== null) {
    window.clearInterval(transferTimer.value)
    transferTimer.value = null
  }

  if (uploadTimer.value !== null) {
    window.clearTimeout(uploadTimer.value)
    uploadTimer.value = null
  }
  if (confettiTimer.value !== null) {
    window.clearTimeout(confettiTimer.value)
    confettiTimer.value = null
  }

  timers.value.forEach((timer) => {
    window.clearTimeout(timer)
  })
  timers.value = []
}

function triggerUpload(action: UpdateChoice) {
  trackNoAppDemoStepEvent(step.value, 'update-selected', {
    action: action.id,
    step: step.value,
  })
  clearAllTimers()
  selectedAction.value = action
  isUploading.value = true
  isUploadComplete.value = false
  hasOpenedUpdatedApp.value = false
  phoneStage.value = 'app'
  const appId = formatDemoAppId(appName.value || 'demo-app')
  uploadLines.value = [`$ ${getUploadCommand(appId)}`]
  transferPosition.value = 0

  queueTerminalLines(uploadLines, [
    { line: `$ ${action.command.replace('<appId>', appId)}`, delay: 650 },
    { line: '  - verifying bundle', delay: 1250 },
    { line: `  - ${action.terminalLine}`, delay: 1900 },
    { line: '  - sending update to Capgo edge', delay: 2550 },
    { line: '  - pushing over secure channel', delay: 3200 },
    { line: '✔ update sent to connected device', delay: 3850 },
  ])

  transferTimer.value = window.setInterval(() => {
    transferPosition.value += 6
  }, 130)

  uploadTimer.value = window.setTimeout(() => {
    if (transferTimer.value !== null)
      window.clearInterval(transferTimer.value)

    transferPosition.value = 100
    isUploading.value = false
    isUploadComplete.value = true
    phoneTheme.value = action.id === 'bg-color' ? 'warm' : 'default'

    trackNoAppDemoStepEvent(step.value, 'upload-completed', {
      action: action.id,
      step: step.value,
    })
    step.value = 3
  }, 4200)
}

function openOnboarding() {
  trackNoAppDemoStepEvent(step.value, 'create-app-clicked', {
    step: step.value,
    can_continue: canContinueOnboarding.value,
  })
  closeModal()
  router.push('/app/new')
}

watch(
  () => props.open,
  (show) => {
    if (show) {
      resetDemo()
      trackNoAppDemoStepEvent(step.value, 'opened', { step: step.value })
    }
  },
)

watch(hasOpenedUpdatedApp, (opened) => {
  if (opened && selectedAction.value?.id === 'confetti')
    triggerConfetti(false)
})

watch(step, (newStep, oldStep) => {
  if (newStep !== oldStep) {
    trackNoAppDemoStepEvent('global', 'step-changed', {
      from: oldStep,
      to: newStep,
    })
  }
})

onUnmounted(() => {
  clearAllTimers()
})
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" />
    <div
      class="relative z-10 w-full max-w-6xl max-h-[90vh] overflow-hidden rounded-[28px] border border-slate-200 bg-base-100 shadow-2xl"
      role="dialog"
      aria-modal="true"
    >
      <button
        class="absolute top-4 right-4 h-9 w-9 text-base-content/60 d-btn d-btn-sm d-btn-circle d-btn-ghost"
        aria-label="Close modal"
        type="button"
        @click="closeModal"
      >
        <i-heroicons-x-mark class="w-4 h-4" />
      </button>

      <div class="overflow-y-auto max-h-[90vh]">
        <div class="grid gap-0 overflow-hidden md:grid-cols-[1.08fr,0.92fr]">
          <div class="flex flex-col h-full gap-4 p-5 bg-base-100 md:p-6">
            <div>
              <p class="inline-flex rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-semibold tracking-[0.08em] text-violet-700">
                START WITH CAPGO
              </p>
              <div class="p-1.5 mt-3 border rounded-2xl border-base-200 bg-base-200">
                <div class="grid grid-cols-3 gap-2">
                  <div
                    v-for="entry in onboardingSteps"
                    :key="entry.id"
                    class="px-3 py-2 transition-colors duration-200 border rounded-xl"
                    :class="currentStepText(entry.id)"
                  >
                    <p class="text-[11px] font-semibold tracking-wide">
                      {{ entry.id }}. {{ entry.label }}
                    </p>
                    <p class="mt-1 text-[11px]" :class="entry.id <= step ? 'opacity-80' : 'text-base-content/40'">
                      {{ entry.caption }}
                    </p>
                  </div>
                </div>
              </div>
              <h2 class="mt-3 text-2xl font-semibold text-base-content">
                {{ stepTitle }}
              </h2>
              <p class="max-w-2xl mt-1.5 text-sm leading-relaxed text-base-content/70">
                {{ stepDescription }}
              </p>
            </div>

            <div class="flex-1 space-y-4">
              <div v-if="isCreateStep" class="flex flex-col gap-3">
                <form class="flex gap-2" @submit.prevent="submitAppName">
                  <label for="demo-app-name" class="sr-only">App name</label>
                  <input
                    id="demo-app-name"
                    v-model="appName"
                    type="text"
                    placeholder="App Name"
                    maxlength="40"
                    :disabled="isCreatingApp"
                    class="flex-1 rounded-xl border border-base-200 bg-base-100 px-4 py-2.5 text-sm text-base-content placeholder-base-content/40 shadow-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 disabled:opacity-50"
                  >
                  <button
                    type="submit"
                    :disabled="!appName.trim() || isCreatingApp"
                    class="rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {{ isCreatingApp ? 'Creating…' : 'Continue' }}
                  </button>
                </form>
                <p v-if="isCreatingApp" class="text-xs text-base-content/60">
                  Running <span class="font-mono text-emerald-600">{{ CAPGO_CLI_COMMAND }} app add</span> ...
                </p>
              </div>

              <div v-else-if="isUploadStep" class="grid grid-cols-3 gap-2 xl:gap-3">
                <button
                  v-for="choice in updateChoices"
                  :key="choice.id"
                  class="h-full p-3 text-left transition bg-base-100 border rounded-xl border-base-200 hover:border-violet-300 hover:bg-violet-50 sm:p-4 sm:rounded-2xl"
                  type="button"
                  :disabled="isUploading"
                  :class="isUploading ? 'opacity-60 cursor-not-allowed' : ''"
                  @click="triggerUpload(choice)"
                >
                  <p class="text-sm font-semibold text-base-content">
                    {{ choice.label }}
                  </p>
                  <p class="mt-1 text-xs text-base-content/60">
                    Result: {{ choice.result }}
                  </p>
                </button>
              </div>

              <div v-else class="flex flex-col h-full space-y-3">
                <article class="p-4 bg-base-100 border shadow-sm rounded-2xl border-base-200">
                  <p class="text-sm text-base-content/70">
                    {{ phoneStatusMessage }}
                  </p>
                  <p class="mt-2 text-xl font-semibold text-base-content">
                    {{ selectedActionResult }}
                  </p>
                </article>
              </div>
            </div>
          </div>

          <div class="relative flex items-center justify-center p-4 border-l border-slate-100 bg-gradient-to-b from-base-100 to-base-200">
            <div class="w-full max-w-[56rem] space-y-3">
              <div class="flex flex-col items-center gap-3 md:flex-row">
                <div class="flex-1 w-full p-4 border rounded-xl border-slate-800 bg-slate-950 md:flex-[2.2]">
                  <div class="mb-3 inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-[11px] text-slate-100">
                    <span class="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                    Demo Terminal
                  </div>
                  <div class="h-52 p-2 space-y-1 overflow-hidden font-mono text-xs leading-snug rounded-lg bg-black/70 text-emerald-200">
                    <p v-for="(line, index) in terminalLines" :key="`${line}-${index}`">
                      {{ line }}
                    </p>
                    <p v-if="terminalLiveMessage" class="text-cyan-300">
                      {{ terminalLiveMessage }}
                    </p>
                    <p v-else-if="!terminalLines.length" class="text-slate-400">
                      {{ terminalIdleMessage }}
                    </p>
                    <p v-else class="text-slate-400">
                      {{ terminalDoneMessage }}
                    </p>
                  </div>
                </div>

                <div class="relative h-[10px] min-h-[10px] w-full rounded-full bg-slate-900/10 md:h-full md:w-20 md:flex-none">
                  <span class="absolute inset-x-2 top-1/2 h-[2px] -translate-y-1/2 bg-slate-300" />
                  <span
                    class="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 -translate-x-1/2 rounded-full transition-all duration-150"
                    :class="transferDotClass"
                    :style="wireStyle"
                  />
                </div>

                <div class="flex flex-col items-center">
                  <div class="relative mx-auto h-[380px] w-[202px] rounded-[34px] border-[4px] border-slate-900 bg-slate-900 p-[4px] shadow-2xl">
                    <div class="relative h-full rounded-[28px] overflow-hidden bg-slate-900 p-[3px]">
                      <div class="relative h-full rounded-[22px] bg-gradient-to-b p-3" :class="phoneBackgroundClass">
                        <div class="absolute top-0 w-20 h-4 -translate-x-1/2 pointer-events-none left-1/2 rounded-b-2xl bg-slate-900/80" />
                        <div class="mx-auto mb-3 flex h-4 w-full items-center justify-between text-[9px] font-semibold text-slate-600">
                          <span>9:41</span>
                          <span>◉◉◉ 100%</span>
                        </div>
                        <transition name="app-zoom">
                          <div v-if="showPhoneLauncher" class="absolute z-10 overflow-hidden bg-white inset-[6px] rounded-[24px]">
                            <div v-if="phoneStage === 'launching'" class="absolute inset-0 flex flex-col items-center justify-center bg-white">
                              <span
                                class="relative inline-flex h-20 w-20 items-center justify-center rounded-[2rem] text-3xl shadow-lg"
                                :style="selectedAppIconStyle"
                              >
                                {{ selectedAppVisual.icon }}
                              </span>
                            </div>
                            <div v-else-if="phoneStage === 'app'" class="absolute inset-0 flex flex-col transition-colors duration-500" :class="isBgColorUpdateApplied ? 'bg-indigo-900 text-white' : 'bg-white text-slate-900'">
                              <div class="flex items-center gap-3 px-4 pt-8 pb-4 border-b" :class="isBgColorUpdateApplied ? 'border-indigo-800' : 'border-slate-100'">
                                <span
                                  class="inline-flex items-center justify-center w-10 h-10 text-lg shadow-sm rounded-2xl"
                                  :style="selectedAppIconStyle"
                                >
                                  {{ selectedAppVisual.icon }}
                                </span>
                                <div>
                                  <p class="text-sm font-bold">
                                    {{ phoneAppTitle }}
                                  </p>
                                  <p class="text-[11px] opacity-70">
                                    v{{ hasOpenedUpdatedApp ? '1.0.1' : '1.0.0' }}
                                  </p>
                                </div>
                              </div>

                              <div class="flex flex-col items-center justify-center flex-1 p-4 text-center">
                                <template v-if="isConfettiUpdateApplied">
                                  <button type="button" class="px-6 py-3 font-bold text-white transition-transform rounded-full shadow-lg bg-violet-600 active:scale-95" @click="triggerConfetti">
                                    🎉 Show Confetti
                                  </button>
                                </template>
                                <template v-else>
                                  <div
                                    class="flex items-center justify-center w-16 h-16 mb-4 text-3xl shadow-inner rounded-2xl"
                                    :style="selectedAppIconStyle"
                                  >
                                    {{ selectedAppVisual.icon }}
                                  </div>
                                  <p class="text-sm opacity-70 max-w-[180px]">
                                    {{ hasOpenedUpdatedApp ? 'Update successfully applied via Capgo!' : 'This is the initial version of your app.' }}
                                  </p>
                                </template>
                              </div>

                              <div v-if="showConfetti" class="absolute inset-0 z-20 overflow-hidden pointer-events-none">
                                <div
                                  v-for="piece in confettiPieces"
                                  :key="piece.id"
                                  class="absolute confetti-piece -top-5"
                                  :style="`--left:${piece.left}%; --dur:${piece.duration}s; --delay:${piece.delay}s; --color:${piece.color};`"
                                />
                              </div>
                            </div>
                          </div>
                        </transition>
                        <template v-if="showPhoneHome">
                          <div class="grid grid-cols-4 px-2 mt-4 gap-x-3 gap-y-4">
                            <div
                              v-for="homeApp in springboardApps"
                              :key="homeApp.id"
                              class="flex flex-col items-center"
                            >
                              <button
                                type="button"
                                class="relative flex h-10 w-10 items-center justify-center rounded-2xl text-[16px] shadow-sm overflow-hidden transition-transform active:scale-95"
                                :style="getSpringboardIconStyle(homeApp)"
                                @click="homeApp.isDemo && installedAppId && phoneStage === 'home' ? openAppFromPhoneHome(true) : undefined"
                              >
                                {{ homeApp.icon }}
                                <div v-if="showSpringboardInstallOverlay(homeApp)" class="absolute inset-0 flex items-center justify-center bg-black/40">
                                  <svg class="w-6 h-6 -rotate-90" viewBox="0 0 36 36">
                                    <circle cx="18" cy="18" r="16" fill="none" class="stroke-white/30" stroke-width="2" />
                                    <circle cx="18" cy="18" r="8" fill="none" class="stroke-white" stroke-width="16" stroke-dasharray="50.26" stroke-dashoffset="50.26" style="animation: ios-install 0.9s linear forwards;" />
                                  </svg>
                                </div>
                              </button>
                              <p class="mt-1 text-[8px] font-medium leading-[1.05] text-slate-800 truncate w-full text-center drop-shadow-sm">
                                {{ homeApp.name }}
                              </p>
                            </div>
                          </div>

                          <div class="flex items-center justify-center gap-1 mt-2">
                            <span class="h-1.5 w-1.5 rounded-full bg-violet-500" />
                            <span class="h-1.5 w-1.5 rounded-full bg-slate-300" />
                          </div>

                          <div class="absolute inset-x-3 bottom-3 rounded-[24px] bg-white/40 backdrop-blur-md p-2.5">
                            <div class="grid grid-cols-4 gap-2">
                              <div
                                v-for="dockApp in springboardDockApps"
                                :key="`dock-large-${dockApp.id}`"
                                class="relative flex h-10 w-10 mx-auto items-center justify-center rounded-2xl text-[16px] shadow-sm overflow-hidden"
                                :class="dockApp.isDemo ? '' : 'bg-white/60 text-slate-500'"
                                :style="getSpringboardIconStyle(dockApp)"
                              >
                                {{ dockApp.icon }}
                                <div v-if="showSpringboardInstallOverlay(dockApp)" class="absolute inset-0 flex items-center justify-center bg-black/40">
                                  <svg class="w-6 h-6 -rotate-90" viewBox="0 0 36 36">
                                    <circle cx="18" cy="18" r="16" fill="none" class="stroke-white/30" stroke-width="2" />
                                    <circle cx="18" cy="18" r="8" fill="none" class="stroke-white" stroke-width="16" stroke-dasharray="50.26" stroke-dashoffset="50.26" style="animation: ios-install 0.9s linear forwards;" />
                                  </svg>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div class="absolute w-12 h-1 -translate-x-1/2 rounded-full bottom-1 left-1/2 bg-black/20" />
                        </template>
                      </div>
                    </div>
                  </div>

                  <div class="flex items-center justify-center w-full mt-4 h-14">
                    <button
                      v-if="showReopenButton"
                      class="px-6 py-3 font-bold text-white transition-colors rounded-full shadow-lg bg-violet-600 hover:bg-violet-700 animate-bounce"
                      type="button"
                      @click="restartApp"
                    >
                      Background & Reopen App
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="canContinueOnboarding" class="flex justify-center pt-2">
                <button
                  class="w-auto px-6 d-btn d-btn-primary"
                  type="button"
                  :disabled="!canContinueOnboarding"
                  :class="!canContinueOnboarding ? 'opacity-50 cursor-not-allowed' : ''"
                  @click="openOnboarding"
                >
                  Create app now
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-zoom-enter-active {
  animation: app-zoom-in 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  transform-origin: center 60%;
}
.app-zoom-leave-active {
  animation: app-zoom-out 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  transform-origin: center 60%;
}
@keyframes app-zoom-in {
  0% {
    transform: scale(0.15);
    opacity: 0;
    border-radius: 40%;
  }
  100% {
    transform: scale(1);
    opacity: 1;
    border-radius: 0;
  }
}
@keyframes app-zoom-out {
  0% {
    transform: scale(1);
    opacity: 1;
    border-radius: 0;
  }
  100% {
    transform: scale(0.15);
    opacity: 0;
    border-radius: 40%;
  }
}

@keyframes fall {
  0% {
    transform: translateY(0) rotate(0deg);
    opacity: 1;
  }
  100% {
    transform: translateY(420px) rotate(720deg);
    opacity: 0;
  }
}

.confetti-piece {
  left: var(--left);
  width: 8px;
  height: 16px;
  border-radius: 9999px;
  background: var(--color);
  box-shadow: 0 0 6px rgb(255 255 255 / 45%);
  animation: fall var(--dur) linear var(--delay) forwards;
}

@keyframes ios-install {
  0% {
    stroke-dashoffset: 50.26;
  }
  100% {
    stroke-dashoffset: 0;
  }
}
</style>
