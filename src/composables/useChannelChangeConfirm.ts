import type { ChannelImpactBundleRef, ChannelImpactResponse, ChannelImpactResult, ChannelImpactTargetRequest } from '~/services/channelImpact'
import type { BundleChannelCompatibility } from '~/services/nativePackageCompatibility'
import type { DialogV2Button } from '~/stores/dialogv2'
import { computed, reactive, watch } from 'vue'
import { i18n } from '~/modules/i18n'
import { fetchChannelImpact, formatImpactPercent } from '~/services/channelImpact'
import { useDialogV2Store } from '~/stores/dialogv2'

/**
 * One confirm dialog for every change of what a channel serves: set a bundle,
 * promote it to another channel, make it the progressive rollout target, or
 * revert (roll back to the previous bundle / back to the store version). It
 * shows who will actually get the change (device counts, store builds and real
 * example devices) and folds the native-package compatibility warning in.
 * Rendered by ChannelChangeDialog.vue, mounted once in App.vue.
 */
export const CHANNEL_CHANGE_DIALOG_ID = 'channel-change-impact'
const CHANNEL_CHANGE_CONFIRM_BUTTON_ID = 'channel-change-confirm'

export type ChannelChangeAction = 'set' | 'promote' | 'rollout' | 'revert'
export type RevertChoice = 'previous' | 'builtin'

export type ChannelChangeCompatibility = BundleChannelCompatibility

export interface ChannelChangeOptions {
  appId: string
  channelId: number
  channelName: string
  action: ChannelChangeAction
  /** Bundle being set (set, promote, rollout). */
  bundle?: ChannelImpactBundleRef
  /** Bundle the channel serves now (shown in the revert question). */
  currentBundleName?: string | null
  /** Rollout share used to estimate the first wave (rollout action). */
  rolloutPercentageBps?: number
  /** Rollout target replaced by this change (rollout action). */
  replacesRolloutTarget?: string | null
  /** Progressive rollout stopped by this change (revert, or a new stable bundle). */
  stopsRolloutTarget?: string | null
  compatibility?: ChannelChangeCompatibility | null
  /**
   * Revert: the native-package warning for rolling back to the previous bundle,
   * checked once the impact response names that bundle. Throws when it cannot
   * be checked; the roll back choice then stays blocked.
   */
  previousCompatibility?: (previous: ChannelImpactBundleRef) => Promise<ChannelChangeCompatibility | null>
  /** Overrides the default title and confirm label (e.g. "Rollback to this version" from the history table). */
  title?: string
  confirmText?: string
}

export type ChannelChangeResult
  = | { confirmed: true, choice: RevertChoice | null, previousBundle: ChannelImpactBundleRef | null }
    | { confirmed: false, next: 'select-bundle' | 'view-dependencies' | null, dependenciesPath?: string }

interface PreviousCompatibility {
  loading: boolean
  failed: boolean
  value: ChannelChangeCompatibility | null
}

interface ChannelChangeState {
  options: ChannelChangeOptions | null
  response: ChannelImpactResponse | null
  loading: boolean
  failed: boolean
  choice: RevertChoice | null
  previousCompat: PreviousCompatibility
  requestId: number
}

const NO_PREVIOUS_COMPAT: PreviousCompatibility = { loading: false, failed: false, value: null }

const state = reactive<ChannelChangeState>({
  options: null,
  response: null,
  loading: false,
  failed: false,
  choice: null,
  previousCompat: { ...NO_PREVIOUS_COMPAT },
  requestId: 0,
})

function targetsFor(options: ChannelChangeOptions): ChannelImpactTargetRequest[] {
  if (options.action === 'revert')
    return [{ kind: 'previous' }, { kind: 'builtin' }]
  if (!options.bundle)
    return [{ kind: 'builtin' }]
  return [{ kind: 'bundle', version_id: options.bundle.id }]
}

async function loadImpact(options: ChannelChangeOptions) {
  const requestId = ++state.requestId
  state.loading = true
  state.failed = false
  state.response = null
  try {
    let response: ChannelImpactResponse
    try {
      response = await fetchChannelImpact({
        appId: options.appId,
        channelId: options.channelId,
        targets: targetsFor(options),
        mode: options.action === 'rollout' ? 'rollout' : 'stable',
        rolloutPercentageBps: options.action === 'rollout' ? options.rolloutPercentageBps : undefined,
      })
    }
    catch (error) {
      // A channel without history has no "previous" target: ask for the store version only.
      if (options.action !== 'revert')
        throw error
      response = await fetchChannelImpact({ appId: options.appId, channelId: options.channelId, targets: [{ kind: 'builtin' }] })
    }
    if (requestId === state.requestId) {
      state.response = response
      void checkPreviousCompatibility(options, response, requestId)
    }
  }
  catch (error) {
    console.error('Cannot load channel impact', error)
    if (requestId === state.requestId)
      state.failed = true
  }
  finally {
    if (requestId === state.requestId)
      state.loading = false
  }
}

/** Revert: the native-package warning for the previous bundle, once the response names it. */
async function checkPreviousCompatibility(options: ChannelChangeOptions, response: ChannelImpactResponse, requestId: number) {
  const previous = response.previous_bundle
  if (options.action !== 'revert' || !previous || !options.previousCompatibility)
    return
  state.previousCompat = { loading: true, failed: false, value: null }
  try {
    const value = await options.previousCompatibility(previous)
    if (requestId === state.requestId)
      state.previousCompat = { loading: false, failed: false, value }
  }
  catch (error) {
    console.error('Cannot check the native packages of the previous bundle', error)
    if (requestId === state.requestId)
      state.previousCompat = { loading: false, failed: true, value: null }
  }
}

/** The native-package warning that applies to the change shown now. */
function activeCompatibility(options: ChannelChangeOptions | null, choice: RevertChoice | null): ChannelChangeCompatibility | null {
  if (!options)
    return null
  if (options.action === 'revert')
    return choice === 'previous' ? state.previousCompat.value : null
  return options.compatibility ?? null
}

/** Revert can only be confirmed once a choice is made and, for the previous bundle, its native packages were checked. */
function confirmBlocked(options: ChannelChangeOptions) {
  if (options.action !== 'revert')
    return false
  if (!state.choice)
    return true
  return state.choice === 'previous' && (state.previousCompat.loading || state.previousCompat.failed)
}

/** Impact of the change currently shown (the picked revert choice, or the single target). */
export function selectImpact(response: ChannelImpactResponse | null, action: ChannelChangeAction | undefined, choice: RevertChoice | null): ChannelImpactResult | null {
  if (!response)
    return null
  if (action !== 'revert')
    return response.impacts[0] ?? null
  if (!choice)
    return null
  const wantKind = choice === 'builtin' ? 'builtin' : 'bundle'
  return response.impacts.find(impact => impact.target.kind === wantKind) ?? null
}

export function useChannelChangeState() {
  return {
    state,
    impact: computed(() => selectImpact(state.response, state.options?.action, state.choice)),
    previousBundle: computed(() => state.response?.previous_bundle ?? null),
    compatibility: computed(() => activeCompatibility(state.options, state.choice)),
  }
}

function t(key: string, values?: Record<string, unknown>) {
  return values ? i18n.global.t(key, values) : i18n.global.t(key)
}

function titleFor(options: ChannelChangeOptions) {
  if (options.title)
    return options.title
  const values = { bundle: options.bundle?.name ?? '', channel: options.channelName }
  switch (options.action) {
    case 'revert':
      return t('channel-revert-confirm-title')
    case 'promote':
      return t('channel-impact-title-promote', values)
    case 'rollout':
      return options.rolloutPercentageBps
        ? t('channel-impact-title-rollout', { ...values, percent: formatImpactPercent(options.rolloutPercentageBps, 10000) })
        : t('channel-impact-title-rollout-zero', values)
    default:
      return t('channel-impact-title-set', values)
  }
}

function confirmLabel(options: ChannelChangeOptions, choice: RevertChoice | null, previous: ChannelImpactBundleRef | null) {
  if (options.action === 'revert') {
    if (choice === 'previous' && previous)
      return t('channel-revert-previous-button', { bundle: previous.name })
    if (choice === 'builtin')
      return t('channel-revert-button')
    return t('channel-revert-choose-button')
  }
  if (options.compatibility)
    return t('channel-impact-accept-and-continue')
  if (options.confirmText)
    return options.confirmText
  if (options.action === 'promote')
    return t('promote')
  if (options.action === 'rollout')
    return options.rolloutPercentageBps ? t('channel-impact-confirm-rollout-start') : t('channel-impact-confirm-rollout')
  return t('set-bundle')
}

/**
 * Open the impact confirm and resolve with the user's decision. Callers apply
 * the change themselves when `confirmed` is true.
 */
export async function confirmChannelChange(options: ChannelChangeOptions): Promise<ChannelChangeResult> {
  const dialogStore = useDialogV2Store()
  // One confirm at a time: a second call would replace the visible dialog and
  // both callers would then apply what only one of them showed.
  if (state.options)
    return { confirmed: false, next: null }
  state.options = options
  state.choice = null
  state.previousCompat = { ...NO_PREVIOUS_COMPAT }
  void loadImpact(options)

  let next: 'select-bundle' | 'view-dependencies' | null = null
  const buildButtons = (): DialogV2Button[] => {
    const buttons: DialogV2Button[] = [{ text: t('button-cancel'), role: 'cancel' }]
    if (options.action === 'revert') {
      buttons.push({
        text: t('channel-revert-select-bundle'),
        role: 'secondary',
        handler: () => {
          next = 'select-bundle'
        },
      })
    }
    const compatibility = activeCompatibility(options, state.choice)
    if (compatibility) {
      buttons.push({
        text: t('view-dependencies'),
        role: 'secondary',
        handler: () => {
          next = 'view-dependencies'
        },
      })
    }
    buttons.push({
      id: CHANNEL_CHANGE_CONFIRM_BUTTON_ID,
      text: confirmLabel(options, state.choice, state.response?.previous_bundle ?? null),
      role: options.action === 'revert' || compatibility ? 'danger' : 'primary',
      disabled: confirmBlocked(options),
      handler: () => {
        if (confirmBlocked(options))
          return false
      },
    })
    return buttons
  }

  dialogStore.openDialog({
    id: CHANNEL_CHANGE_DIALOG_ID,
    title: titleFor(options),
    size: 'xl',
    preventAccidentalClose: true,
    buttons: buildButtons(),
  })

  // The buttons follow the revert choice ("Roll back to 1.2.3" / "Revert to store version")
  // and the native-package check of the previous bundle.
  const stopWatching = watch(() => [state.choice, state.response?.previous_bundle?.name, state.previousCompat.loading, state.previousCompat.failed, state.previousCompat.value], () => {
    if (dialogStore.showDialog && dialogStore.dialogOptions?.id === CHANNEL_CHANGE_DIALOG_ID)
      dialogStore.dialogOptions = { ...dialogStore.dialogOptions, buttons: buildButtons() }
  })

  const canceled = await dialogStore.onDialogDismiss()
  // Another dialog may have replaced this one (openDialog does not check for an
  // open dialog). Its buttons also close the dialog, so only this confirm's own
  // button counts as a yes.
  const confirmedByButton = dialogStore.lastButtonRole === CHANNEL_CHANGE_CONFIRM_BUTTON_ID
  stopWatching()
  const choice = state.choice
  const previousBundle = state.response?.previous_bundle ?? null
  const dependenciesPath = activeCompatibility(options, choice)?.dependenciesPath
  state.requestId++
  state.options = null
  state.response = null
  state.loading = false
  state.failed = false
  state.choice = null
  state.previousCompat = { ...NO_PREVIOUS_COMPAT }

  if (canceled || next || !confirmedByButton)
    return { confirmed: false, next, dependenciesPath }
  return { confirmed: true, choice, previousBundle }
}

export function setRevertChoice(choice: RevertChoice) {
  if (choice === 'previous' && !state.response?.previous_bundle)
    return
  state.choice = choice
}
