import type { ChannelImpactBundleRef, ChannelImpactResponse, ChannelImpactResult, ChannelImpactTargetRequest } from '~/services/channelImpact'
import type { DialogV2Button } from '~/stores/dialogv2'
import { computed, reactive, watch } from 'vue'
import { i18n } from '~/modules/i18n'
import { fetchChannelImpact } from '~/services/channelImpact'
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

export type ChannelChangeAction = 'set' | 'promote' | 'rollout' | 'revert'
export type RevertChoice = 'previous' | 'builtin'

export interface ChannelChangeCompatibility {
  /** Native packages of the bundle that the channel's current bundle does not ship (or ships in another version). */
  packages: string[]
  /** Dependencies page of the bundle, diffed against the channel's current bundle. */
  dependenciesPath: string
}

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
  /** Overrides the default title and confirm label (e.g. "Rollback to this version" from the history table). */
  title?: string
  confirmText?: string
}

export type ChannelChangeResult
  = | { confirmed: true, choice: RevertChoice | null, previousBundle: ChannelImpactBundleRef | null }
    | { confirmed: false, next: 'select-bundle' | 'view-dependencies' | null }

interface ChannelChangeState {
  options: ChannelChangeOptions | null
  response: ChannelImpactResponse | null
  loading: boolean
  failed: boolean
  choice: RevertChoice | null
  requestId: number
}

const state = reactive<ChannelChangeState>({
  options: null,
  response: null,
  loading: false,
  failed: false,
  choice: null,
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
    if (requestId === state.requestId)
      state.response = response
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
      return t('channel-impact-title-rollout', values)
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
    return t('channel-impact-confirm-rollout')
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
    if (options.compatibility) {
      buttons.push({
        text: t('view-dependencies'),
        role: 'secondary',
        handler: () => {
          next = 'view-dependencies'
        },
      })
    }
    const revertUnchosen = options.action === 'revert' && !state.choice
    buttons.push({
      id: 'channel-change-confirm',
      text: confirmLabel(options, state.choice, state.response?.previous_bundle ?? null),
      role: options.action === 'revert' || options.compatibility ? 'danger' : 'primary',
      disabled: revertUnchosen,
      handler: () => {
        if (options.action === 'revert' && !state.choice)
          return false
      },
    })
    return buttons
  }

  dialogStore.openDialog({
    id: CHANNEL_CHANGE_DIALOG_ID,
    title: titleFor(options),
    size: '2xl',
    preventAccidentalClose: true,
    buttons: buildButtons(),
  })

  // The confirm label follows the revert choice ("Roll back to 1.2.3" / "Revert to store version").
  const stopWatching = watch(() => [state.choice, state.response?.previous_bundle?.name], () => {
    if (dialogStore.showDialog && dialogStore.dialogOptions?.id === CHANNEL_CHANGE_DIALOG_ID)
      dialogStore.dialogOptions = { ...dialogStore.dialogOptions, buttons: buildButtons() }
  })

  const canceled = await dialogStore.onDialogDismiss()
  stopWatching()
  const choice = state.choice
  const previousBundle = state.response?.previous_bundle ?? null
  state.requestId++
  state.options = null
  state.response = null
  state.loading = false
  state.failed = false
  state.choice = null

  if (canceled || next)
    return { confirmed: false, next }
  return { confirmed: true, choice, previousBundle }
}

export function setRevertChoice(choice: RevertChoice) {
  if (choice === 'previous' && !state.response?.previous_bundle)
    return
  state.choice = choice
}
