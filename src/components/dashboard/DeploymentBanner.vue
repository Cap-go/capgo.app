<script setup lang="ts">
/**
 * DeploymentBanner Component
 *
 * An intelligent banner component that automatically detects when new bundles are available
 * and provides one-click deployment to default channels with proper permission checks.
 *
 * @component
 *
 * Features:
 * - Automatic detection of deployable bundles
 * - Admin-only visibility (enforces permission checks)
 * - One-click deployment with confirmation dialog
 * - Visual feedback with confetti animation on success
 * - Real-time state updates
 *
 * Security:
 * - Only visible to users with admin or super_admin roles
 * - Requires explicit confirmation before deployment
 * - Validates channel and bundle existence before showing
 *
 * @example
 * <DeploymentBanner :app-id="appId" @deployed="refreshData" />
 */

import type { Database } from '~/types/supabase.types'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconInfo from '~icons/lucide/info'
import { checkPermissions } from '~/services/permissions'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'

/**
 * Component props interface
 */
interface Props {
  /** The application identifier for which to show deployment status */
  appId: string
}

const props = defineProps<Props>()

/**
 * Component events
 * @event deployed - Emitted after successful deployment to default channels
 */
const emit = defineEmits<{
  deployed: []
}>()

// Initialize services and stores
const { t } = useI18n()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()

// Component state
/** Indicates if initial data is being loaded */
const loading = ref(true)
/** Indicates if a deployment is currently in progress */
const deploying = ref(false)
/** The most recent bundle available for deployment */
const latestBundle = ref<Database['public']['Tables']['app_versions']['Row'] | null>(null)
type DefaultChannel = Pick<
  Database['public']['Tables']['channels']['Row'],
  'id' | 'name' | 'ios' | 'android' | 'electron' | 'public' | 'version'
>

/** Default channels configured for downloads (public channels) */
const defaultChannels = ref<DefaultChannel[]>([])
/** Selected default channel IDs for deployment */
const selectedChannelIds = ref<number[]>([])

const deployDialogId = 'deploy-default-channels'

type PlatformKey = 'ios' | 'android' | 'electron'
interface DeployTarget {
  id: number
  name: string
  platforms: PlatformKey[]
  needsDeploy: boolean
}

const deployTargets = computed<DeployTarget[]>(() => {
  const bundle = latestBundle.value
  if (!bundle)
    return []

  return defaultChannels.value
    .filter(channel => channel.ios || channel.android || channel.electron)
    .map(channel => ({
      id: channel.id,
      name: channel.name,
      platforms: [
        ...(channel.ios ? ['ios'] as PlatformKey[] : []),
        ...(channel.android ? ['android'] as PlatformKey[] : []),
        ...(channel.electron ? ['electron'] as PlatformKey[] : []),
      ],
      needsDeploy: channel.version !== bundle.id,
    }))
})

/**
 * Computed property that determines if the banner should be visible.
 * Banner appears when:
 * 1. Data has finished loading
 * 2. Default channels exist
 * 3. A latest bundle exists
 * 4. User has admin permissions
 * 5. At least one default channel differs from the latest bundle
 *
 * @returns {boolean} True if banner should be shown, false otherwise
 */
const showBanner = computed(() => {
  // Don't show banner during initial load or if data is missing
  if (loading.value || !latestBundle.value)
    return false

  if (!deployTargets.value.length)
    return false

  return deployTargets.value.some(target => target.needsDeploy)
})

/**
 * Loads necessary data for the deployment banner.
 *
 * This function performs two main queries:
 * 1. Retrieves the default channel configuration and filters by channel permission
 * 2. Gets the latest deployable bundle
 *
 * The banner will only show if deployable channel and bundle data are available.
 *
 * @async
 * @returns {Promise<void>}
 */
async function loadData() {
  if (!props.appId) {
    loading.value = false
    return
  }
  loading.value = true
  defaultChannels.value = []
  latestBundle.value = null
  selectedChannelIds.value = []
  console.log('[DeploymentBanner] Loading data for app:', props.appId)

  try {
    // Step 1: Get default channels configuration (public download channels)
    const { data: publicChannels } = await supabase
      .from('channels')
      .select('id, name, ios, android, electron, public, version')
      .eq('app_id', props.appId)
      .eq('public', true)

    const platformChannels = publicChannels?.filter(channel => channel.ios || channel.android || channel.electron) ?? []
    const allowedChannels = await Promise.all(platformChannels.map(async (channel) => {
      const allowed = await checkPermissions('channel.promote_bundle', { appId: props.appId, channelId: channel.id })
      return allowed ? channel : null
    }))

    defaultChannels.value = allowedChannels.filter((channel): channel is DefaultChannel => channel !== null)

    // Step 2: Get latest bundle (excluding special bundle types)
    // We filter out 'unknown' and 'builtin' bundles as these are not deployable
    // Only fetch non-deleted bundles ordered by creation date (newest first)
    const { data: bundles } = await supabase
      .from('app_versions')
      .select('*')
      .eq('app_id', props.appId)
      .eq('deleted', false)
      .neq('name', 'unknown')
      .neq('name', 'builtin')
      .order('created_at', { ascending: false })
      .limit(1)

    latestBundle.value = bundles?.[0] ?? null
  }
  catch (error) {
    // Errors are logged but don't block the UI
    // The banner simply won't show if data loading fails
    console.error('[DeploymentBanner] Error loading data:', error)
  }
  finally {
    // Always reset loading state, even if errors occurred
    loading.value = false
  }
}

/**
 * Executes the actual deployment to default channels.
 *
 * This is the core deployment function that:
 * 1. Updates the default channels' version fields to point to the latest bundle
 * 2. Updates local state for immediate UI feedback (optimistic update)
 * 3. Shows success animation and notification
 * 4. Emits event for parent component to refresh data
 * 5. Reloads banner data in background to hide the banner
 *
 * The deployment is essentially a simple database update that changes which bundle
 * the default channels point to. All actual deployment logic (distributing updates
 * to devices) happens automatically through existing channel mechanisms.
 *
 * @async
 * @returns {Promise<void>}
 */
async function executeDeployment() {
  // Safety check: validate required data is present
  if (!latestBundle.value || selectedChannelIds.value.length === 0)
    return

  const bundle = latestBundle.value
  const allowedTargetIds = new Set(deployTargets.value.map(target => target.id))
  const targetIds = selectedChannelIds.value.filter(id => allowedTargetIds.has(id))
  if (targetIds.length === 0) {
    toast.error(t('no-permission'))
    return
  }

  deploying.value = true

  try {
    console.log('[DeploymentBanner] Starting deployment:', {
      bundleId: bundle.id,
      bundleName: bundle.name,
      channelIds: targetIds,
    })

    // Perform the deployment by updating the channel versions in bulk
    const { data, error } = await supabase
      .from('channels')
      .update({ version: bundle.id })
      .in('id', targetIds)
      .eq('app_id', props.appId) // Extra safety: ensure we're updating the right channels
      .select()

    console.log('[DeploymentBanner] Deployment result:', { data, error })

    if (error) {
      // Deployment failed - show error and return early
      console.error('[DeploymentBanner] Deployment failed:', error)
      toast.error(t('deployment-failed'))
      return
    }

    // Success! Update local state immediately (optimistic update)
    // This hides the banner instantly without waiting for data reload
    defaultChannels.value = defaultChannels.value.map(channel =>
      targetIds.includes(channel.id)
        ? { ...channel, version: bundle.id }
        : channel,
    )

    // Show success feedback to user
    toast.success(t('deployment-success', { bundle: bundle.name }))
    showCelebration()

    // Notify parent component that deployment occurred
    emit('deployed')

    // Reload data in background to ensure banner stays hidden
    await loadData()
  }
  catch (err) {
    console.error('[DeploymentBanner] Deploy error:', err)
    toast.error(t('deployment-failed'))
  }
  finally {
    deploying.value = false
  }
}

function seedSelectedTargets() {
  const deployableTargets = deployTargets.value.filter(target => target.needsDeploy)
  selectedChannelIds.value = deployableTargets.length
    ? deployableTargets.map(target => target.id)
    : deployTargets.value.map(target => target.id)
}

function toggleTargetSelection(id: number) {
  if (selectedChannelIds.value.includes(id)) {
    selectedChannelIds.value = selectedChannelIds.value.filter(existingId => existingId !== id)
  }
  else {
    selectedChannelIds.value = [...selectedChannelIds.value, id]
  }
}

function isTargetSelected(id: number) {
  return selectedChannelIds.value.includes(id)
}

function getPlatformLabel(platforms: PlatformKey[]) {
  const labels: string[] = []
  if (platforms.includes('ios'))
    labels.push(t('platform-ios'))
  if (platforms.includes('android'))
    labels.push(t('platform-android'))
  if (platforms.includes('electron'))
    labels.push(t('platform-electron'))
  return labels.length > 0 ? labels.join(' & ') : t('unknown')
}

/**
 * Handles the deploy button click by showing a confirmation dialog.
 *
 * This is the first step in the deployment flow. It validates that we have
 * the necessary data (bundle and default channels) and then shows a confirmation dialog
 * to prevent accidental deployments.
 *
 * The dialog uses the 'danger' role for the confirm button to emphasize
 * that this is a high-impact deployment action.
 *
 * @async
 * @returns {Promise<void>}
 */
async function handleDeploy() {
  // Safety check: ensure we have both bundle and default channels
  if (!latestBundle.value || deployTargets.value.length === 0)
    return

  const bundle = latestBundle.value
  seedSelectedTargets()

  const bundleName = bundle.name

  // Open confirmation dialog with deployment details
  // User must explicitly confirm before deployment proceeds
  dialogStore.openDialog({
    id: deployDialogId,
    title: t('deploy-default-title'),
    description: t('deploy-default-description', { bundle: bundleName }),
    size: 'lg',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('deploy-confirm'),
        role: 'danger',
        preventClose: true,
        handler: async () => {
          if (!selectedChannelIds.value.length) {
            toast.error(t('deploy-select-channel'))
            return
          }
          dialogStore.closeDialog({ text: t('deploy-confirm'), role: 'danger' })
          await executeDeployment()
        },
      },
    ],
  })
}

/**
 * Shows a celebratory confetti animation after successful deployment.
 *
 * Creates 50 colored particles that fall from the top of the screen
 * with random horizontal movement and rotation. Uses Capgo brand colors
 * for visual consistency.
 *
 * The animation is purely cosmetic and provides positive feedback to the user.
 * All particles are automatically cleaned up after 3 seconds to prevent memory leaks.
 *
 * @returns {void}
 */
function showCelebration() {
  const confettiCount = 50
  // Capgo brand colors + complementary colors for visual appeal
  const colors = ['#119eff', '#515271', '#FF6B6B', '#4ECDC4', '#FFE66D']

  // Create multiple confetti particles with random colors
  for (let i = 0; i < confettiCount; i++) {
    const randomColor = colors[Math.floor(Math.random() * colors.length)]
    createConfetti(randomColor)
  }
}

/**
 * Creates a single confetti particle element and animates it.
 *
 * The particle:
 * - Starts at the top of the viewport (outside visible area)
 * - Falls to the bottom with CSS transitions
 * - Moves horizontally with random drift
 * - Rotates randomly for realistic effect
 * - Fades out as it falls
 * - Is automatically removed from DOM after animation completes
 *
 * Uses CSS transitions for smooth, GPU-accelerated animation.
 *
 * @param {string} color - The hex color code for the confetti particle
 * @returns {void}
 */
function createConfetti(color: string) {
  // Create a small circular div element
  const confetti = document.createElement('div')
  confetti.style.position = 'fixed'
  confetti.style.width = '10px'
  confetti.style.height = '10px'
  confetti.style.backgroundColor = color
  confetti.style.left = `${Math.random() * 100}vw` // Random horizontal start position
  confetti.style.top = '-10px' // Start just above viewport
  confetti.style.borderRadius = '50%' // Make it circular
  confetti.style.pointerEvents = 'none' // Don't interfere with mouse events
  confetti.style.zIndex = '9999' // Show above all other content
  confetti.style.opacity = '1'
  confetti.style.transition = 'all 3s cubic-bezier(0.25, 0.46, 0.45, 0.94)' // Smooth easing

  // Add particle to DOM
  document.body.appendChild(confetti)

  // Trigger animation on next frame (allows CSS transition to work)
  requestAnimationFrame(() => {
    confetti.style.top = '100vh' // Fall to bottom
    confetti.style.left = `${Number.parseFloat(confetti.style.left) + (Math.random() - 0.5) * 100}vw` // Drift horizontally
    confetti.style.opacity = '0' // Fade out
    confetti.style.transform = `rotate(${Math.random() * 360}deg)` // Spin randomly
  })

  // Clean up: remove particle from DOM after animation completes
  // This prevents memory leaks from accumulating DOM elements
  setTimeout(() => {
    confetti.remove()
  }, 3000) // Match transition duration
}

// Lifecycle: Load data when component mounts
watch(
  () => props.appId,
  (appId) => {
    if (!appId)
      return
    loadData()
  },
  { immediate: true },
)

/**
 * Expose public methods for parent component access.
 *
 * This allows parent components to programmatically refresh the banner
 * if needed (e.g., after manual channel updates).
 */
defineExpose({
  refresh: loadData,
})
</script>

<template>
  <!--
    Deployment Banner

    Conditionally rendered banner that appears when:
    - User has admin permissions
    - Default channels exist
    - Latest bundle differs from at least one default channel's current version

    The banner provides:
    - Visual notification (info icon + message)
    - One-click deploy action
    - Loading state during deployment
   -->
  <div
    v-if="showBanner"
    class="mb-4 flex flex-col gap-4 rounded-lg border border-blue-200/80 bg-blue-100/40 px-5 py-3 shadow-sm animate-fade-in dark:border-blue-700/70 dark:bg-[#121b3a] sm:flex-row sm:items-center sm:justify-between"
    style="--animate-fade-in-offset: -10px"
  >
    <!-- Left side: Info icon and message -->
    <div class="flex items-center gap-3">
      <IconInfo class="h-5 w-5 text-blue-500 dark:text-blue-300" />
      <span class="text-sm text-slate-700 dark:text-blue-100">
        {{ t('new-bundle-ready-banner') }}
      </span>
    </div>

    <!-- Right side: Deploy action button -->
    <button
      :disabled="deploying"
      class="flex-shrink-0 inline-flex items-center justify-center rounded-md bg-blue-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:ring-offset-2 focus:ring-offset-blue-100/40 dark:focus:ring-offset-[#121b3a] disabled:opacity-50 disabled:cursor-not-allowed"
      @click="handleDeploy"
    >
      <!-- Button text changes during deployment -->
      <span>{{ deploying ? t('deploying') : t('deploy-now-button') }}</span>
    </button>
  </div>

  <!-- Deploy dialog content -->
  <Teleport
    v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === deployDialogId"
    defer
    to="#dialog-v2-content"
  >
    <div class="space-y-4">
      <div class="p-3 rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40">
        <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
          {{ t('deploy-default-channels-label') }}
        </p>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          {{ t('deploy-default-channels-help') }}
        </p>
      </div>
      <div class="space-y-2">
        <label
          v-for="target in deployTargets"
          :key="target.id"
          class="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600"
        >
          <input
            type="checkbox"
            class="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800"
            :checked="isTargetSelected(target.id)"
            @change="toggleTargetSelection(target.id)"
          >
          <div class="space-y-0.5">
            <p class="text-sm font-medium text-slate-900 dark:text-slate-100">
              {{ target.name }}
            </p>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              {{ getPlatformLabel(target.platforms) }}
            </p>
          </div>
        </label>
      </div>
    </div>
  </Teleport>
</template>
