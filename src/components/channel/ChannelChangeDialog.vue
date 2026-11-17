<script setup lang="ts">
import type { ChannelImpactOutcome, ChannelImpactPlatform } from '~/services/channelImpact'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconWarning from '~icons/lucide/alert-triangle'
import IconRollout from '~icons/lucide/split'
import IconAndroid from '~icons/mdi/android'
import IconApple from '~icons/mdi/apple'
import IconElectron from '~icons/mdi/electron-framework'
import { CHANNEL_CHANGE_DIALOG_ID, setRevertChoice, useChannelChangeState } from '~/composables/useChannelChangeConfirm'
import { formatImpactPercent, STRATEGY_BLOCKED_OUTCOMES } from '~/services/channelImpact'
import { useDialogV2Store } from '~/stores/dialogv2'

// Kept small on purpose: one line with the share of devices that get the
// change, one line on the update strategy when it holds devices back, and at
// most three real example devices that show what happens and why.
const { t } = useI18n()
const dialogStore = useDialogV2Store()
const { state, impact, previousBundle } = useChannelChangeState()

const open = computed(() => dialogStore.showDialog && dialogStore.dialogOptions?.id === CHANNEL_CHANGE_DIALOG_ID && !!state.options)
const options = computed(() => state.options)
const response = computed(() => state.response)
const isRevert = computed(() => options.value?.action === 'revert')
const isRollout = computed(() => options.value?.action === 'rollout')
const targetName = computed(() => impact.value?.target.name ?? options.value?.bundle?.name ?? '')
const showImpact = computed(() => !isRevert.value || !!state.choice)

function fmt(value: number) {
  return value.toLocaleString()
}

/** Device counts shared by both headlines. */
const counts = computed(() => {
  const result = impact.value
  if (!result)
    return null
  // More setups than the server evaluates: only the most common ones were checked.
  const partial = !!response.value?.truncated
  const total = partial ? Math.max(response.value?.total_devices ?? 0, result.total_devices) : result.total_devices
  // Capped assignment lists, or old updaters whose self-assigned channel cannot
  // be read: devices may be counted on the wrong channel, so the counts are
  // estimates in both directions.
  const approximate = !!response.value?.overrides_truncated || (response.value?.legacy_self_assignment_devices ?? 0) > 0
  // A partial scan alone undercounts receivers ("at least"); an estimate does
  // not bound them, so it wins over the lower-bound wording.
  const lowerBound = partial && !approximate
  return { partial, approximate, lowerBound, total, receive: result.receive }
})

/** Set, promote, revert: who switches at their next update check. */
const headline = computed(() => {
  const result = impact.value
  const c = counts.value
  if (!result || !c)
    return ''
  const values = {
    count: c.approximate ? `~${fmt(c.receive)}` : fmt(c.receive),
    total: fmt(c.total),
    percent: formatImpactPercent(c.receive, c.total),
    bundle: targetName.value,
  }
  const kind = result.target.kind === 'builtin' ? 'builtin' : 'gets'
  return t(`channel-impact-headline-${kind}${c.lowerBound ? '-at-least' : ''}`, values)
})

const rolloutBps = computed(() => options.value?.rolloutPercentageBps ?? 0)

/**
 * Rollout: who gets the bundle first at this percentage, and how many devices
 * could take it at all. Everyone else keeps the stable bundle.
 */
const rolloutHeadline = computed(() => {
  const result = impact.value
  const c = counts.value
  if (!isRollout.value || !result || !c)
    return null
  let eligible = fmt(c.receive)
  if (c.approximate)
    eligible = `~${eligible}`
  else if (c.lowerBound)
    eligible = `${eligible}+`
  const values = {
    bundle: targetName.value,
    percent: formatImpactPercent(rolloutBps.value, 10000),
    eligible,
    total: fmt(c.total),
  }
  // A partial scan only checked the most common setups: rarer ones may take it.
  if (!c.receive)
    return { main: t(c.partial ? 'channel-impact-rollout-none-eligible-partial' : 'channel-impact-rollout-none-eligible', values), detail: '' }
  if (!rolloutBps.value)
    return { main: t('channel-impact-rollout-zero-main', values), detail: t('channel-impact-rollout-zero-detail', values) }
  const first = result.rollout_receive ?? 0
  return {
    main: t('channel-impact-rollout-first', { ...values, count: fmt(first) }, first),
    detail: t('channel-impact-rollout-share-detail', values),
  }
})

// The update strategy is the usual reason a new major does not reach most devices.
const strategyHint = computed(() => {
  const result = impact.value
  if (!result?.requirement)
    return ''
  const blocked = [...STRATEGY_BLOCKED_OUTCOMES].some(outcome => (result.outcomes[outcome] ?? 0) > 0)
  if (!blocked)
    return ''
  return t(`channel-impact-why-${result.requirement.strategy}`, { native: result.requirement.native })
})

const compatHint = computed(() => {
  const requirement = impact.value?.requirement
  if (!requirement)
    return t('channel-impact-compat-unguarded')
  const builds = requirement.strategy === 'minor' || requirement.strategy === 'patch'
    ? t('channel-impact-builds-exact', { native: requirement.native })
    : t('channel-impact-builds-or-newer', { native: requirement.native })
  return t('channel-impact-compat-guarded', { builds })
})

const samples = computed(() => (response.value?.samples_included ? impact.value?.samples ?? [] : []).slice(0, 3))

type OutcomeTone = 'gets' | 'already' | 'waits' | 'kept'

function outcomeTone(outcome: ChannelImpactOutcome): OutcomeTone {
  if (outcome === 'receive' || outcome === 'revert_to_builtin' || outcome === 'receive_below_native')
    return 'gets'
  if (outcome === 'already_on_target')
    return 'already'
  if (STRATEGY_BLOCKED_OUTCOMES.has(outcome))
    return 'waits'
  return 'kept'
}

const toneChip: Record<OutcomeTone, string> = {
  gets: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900',
  already: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900',
  waits: 'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900',
  kept: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
}

function outcomeLabel(outcome: ChannelImpactOutcome) {
  const result = impact.value
  const bundle = result?.target.name ?? ''
  // A rollout only picks a share of the devices that can take the bundle.
  if (isRollout.value && outcome === 'receive')
    return t('channel-impact-outcome-rollout-eligible')
  if (isRollout.value && outcome === 'receive_below_native')
    return t('channel-impact-outcome-rollout-eligible-below-native')
  if (outcome === 'already_on_target')
    return result?.target.kind === 'builtin' ? t('channel-impact-outcome-already-builtin') : t('channel-impact-outcome-already', { bundle })
  return t(`channel-impact-outcome-${outcome.replaceAll('_', '-')}`, { bundle, native: result?.requirement?.native ?? '' })
}

function platformIcon(platform: ChannelImpactPlatform) {
  if (platform === 'ios')
    return IconApple
  if (platform === 'android')
    return IconAndroid
  if (platform === 'electron')
    return IconElectron
  return null
}

function platformLabel(platform: ChannelImpactPlatform) {
  return platform === 'unknown' ? t('unknown') : t(`platform-${platform}`)
}

function shortDeviceId(deviceId: string) {
  return deviceId.length > 13 ? `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}` : deviceId
}

function deviceLink(deviceId: string) {
  return `/app/${options.value?.appId}/device/${encodeURIComponent(deviceId)}`
}

function bundleOnDevice(versionName: string, versionBuild: string) {
  return versionName === versionBuild ? t('channel-impact-store-version') : versionName
}

/**
 * What the change does to the channel's progressive rollout, on its own line.
 * Setting the rollout's own bundle as stable is the expected outcome (neutral);
 * dropping or replacing another rollout target is a side effect (amber).
 */
const rolloutNote = computed(() => {
  const opts = options.value
  if (!opts)
    return null
  if (opts.replacesRolloutTarget) {
    // A new rollout target clears the rollout pause (channel trigger).
    const key = response.value?.channel.rollout.paused ? 'channel-impact-rollout-replaces-paused' : 'channel-impact-rollout-replaces'
    return { warn: true, text: t(key, { bundle: opts.replacesRolloutTarget }) }
  }
  if (!opts.stopsRolloutTarget)
    return null
  const nextBundle = isRevert.value
    ? (state.choice === 'previous' ? previousBundle.value?.name : null)
    : opts.bundle?.name
  if (nextBundle && nextBundle === opts.stopsRolloutTarget)
    return { warn: false, text: t('channel-impact-rollout-promoted', { bundle: nextBundle }) }
  return { warn: true, text: t('channel-impact-rollout-canceled', { bundle: opts.stopsRolloutTarget }) }
})

function choose(choice: 'previous' | 'builtin') {
  setRevertChoice(choice)
}
</script>

<template>
  <Teleport v-if="open && options" defer to="#dialog-v2-content">
    <div class="space-y-3 text-left" data-test="channel-change-impact">
      <!-- Revert: ask first what the channel should go back to -->
      <fieldset v-if="isRevert" class="space-y-2" data-test="channel-revert-choices">
        <legend class="mb-2 text-sm text-slate-600 dark:text-slate-300">
          {{ t('channel-revert-question', { channel: options.channelName, bundle: options.currentBundleName || t('channel-impact-store-version') }) }}
        </legend>
        <label
          class="flex items-start gap-3 rounded-lg border p-3 transition-colors"
          :class="[
            state.choice === 'previous' ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-slate-200 dark:border-slate-700',
            previousBundle ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800' : 'cursor-not-allowed opacity-60',
          ]"
          data-test="channel-revert-choice-previous"
        >
          <input
            type="radio"
            name="channel-revert-choice"
            class="d-radio d-radio-sm d-radio-primary mt-0.5"
            :checked="state.choice === 'previous'"
            :disabled="!previousBundle"
            @change="choose('previous')"
          >
          <span class="min-w-0 flex-1">
            <span class="block font-medium text-slate-900 dark:text-white">
              <template v-if="previousBundle">{{ t('channel-revert-option-previous', { bundle: previousBundle.name }) }}</template>
              <template v-else-if="state.loading">{{ t('channel-revert-option-previous-loading') }}</template>
              <template v-else>{{ t('channel-revert-option-previous-generic') }}</template>
            </span>
            <span class="block text-sm text-slate-600 dark:text-slate-400">
              {{ previousBundle || state.loading ? t('channel-revert-option-previous-desc') : t('channel-revert-option-previous-unavailable') }}
            </span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
          :class="state.choice === 'builtin' ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-slate-200 dark:border-slate-700'"
          data-test="channel-revert-choice-builtin"
        >
          <input
            type="radio"
            name="channel-revert-choice"
            class="d-radio d-radio-sm d-radio-primary mt-0.5"
            :checked="state.choice === 'builtin'"
            @change="choose('builtin')"
          >
          <span class="min-w-0 flex-1">
            <span class="block font-medium text-slate-900 dark:text-white">{{ t('revert-to-builtin') }}</span>
            <span class="block text-sm text-slate-600 dark:text-slate-400">{{ t('channel-revert-option-builtin-desc') }}</span>
          </span>
        </label>
      </fieldset>

      <!-- Rollout: what devices outside the rollout keep -->
      <p v-else-if="isRollout" class="text-sm text-slate-600 dark:text-slate-300">
        {{ options.currentBundleName
          ? t('channel-impact-rollout-others', { channel: options.channelName, bundle: options.currentBundleName })
          : t('channel-impact-rollout-others-builtin', { channel: options.channelName }) }}
      </p>

      <!-- Set / promote: what the channel serves now -->
      <p v-else class="text-sm text-slate-600 dark:text-slate-300">
        {{ options.currentBundleName
          ? t('channel-impact-current', { channel: options.channelName, bundle: options.currentBundleName })
          : t('channel-impact-current-builtin', { channel: options.channelName }) }}
      </p>

      <!-- What happens to the progressive rollout, on its own line -->
      <p
        v-if="rolloutNote"
        class="flex items-start gap-2 text-sm"
        :class="rolloutNote.warn ? 'text-amber-800 dark:text-amber-200' : 'text-slate-600 dark:text-slate-300'"
        data-test="channel-change-rollout-note"
      >
        <IconRollout class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span class="min-w-0">{{ rolloutNote.text }}</span>
      </p>

      <!-- Native package compatibility, in one short block -->
      <div
        v-if="options.compatibility"
        class="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100"
        data-test="channel-change-compat"
      >
        <IconWarning class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p class="min-w-0">
          <span class="font-semibold">{{ t('channel-impact-compat-title') }}:</span>
          {{ options.compatibility.packages.join(', ') }}.
          {{ compatHint }}
        </p>
      </div>

      <p v-if="isRevert && !state.choice" class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('channel-revert-pick-prompt') }}
      </p>

      <!-- Impact: the ratio and up to three example devices -->
      <section v-if="showImpact" class="space-y-2" :aria-busy="state.loading" data-test="channel-impact-panel">
        <div v-if="state.loading" class="space-y-2" data-test="channel-impact-loading">
          <p class="text-sm text-slate-500 dark:text-slate-400">
            {{ t('channel-impact-loading') }}
          </p>
          <div v-for="row in 3" :key="row" class="h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
        </div>

        <p v-else-if="state.failed || !impact" class="text-sm text-slate-600 dark:text-slate-300" data-test="channel-impact-failed">
          {{ t('channel-impact-failed') }}
        </p>

        <p v-else-if="!impact.total_devices" class="text-sm text-slate-600 dark:text-slate-300" data-test="channel-impact-empty">
          {{ t('channel-impact-no-devices', { days: response?.window_days ?? 30 }) }}
        </p>

        <template v-else>
          <p v-if="response?.channel.paused" class="text-sm text-amber-800 dark:text-amber-200">
            {{ t('channel-impact-paused') }}
          </p>
          <!-- Rollout: the first wave, then how many could take it -->
          <div v-if="rolloutHeadline" class="space-y-0.5" data-test="channel-impact-headline">
            <p class="text-sm font-semibold text-slate-900 dark:text-white">
              {{ rolloutHeadline.main }}
            </p>
            <p v-if="rolloutHeadline.detail" class="text-sm text-slate-600 dark:text-slate-300">
              {{ rolloutHeadline.detail }}
            </p>
          </div>
          <p v-else class="text-sm font-semibold text-slate-900 dark:text-white" data-test="channel-impact-headline">
            {{ headline }}
          </p>
          <p v-if="strategyHint" class="text-sm text-violet-800 dark:text-violet-200" data-test="channel-impact-strategy">
            {{ strategyHint }}
          </p>

          <ul v-if="samples.length" class="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700" data-test="channel-impact-examples">
            <li v-for="sample in samples" :key="sample.device_id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <component :is="platformIcon(sample.platform)" v-if="platformIcon(sample.platform)" class="size-4 shrink-0 text-slate-500" aria-hidden="true" />
              <span class="sr-only">{{ platformLabel(sample.platform) }}</span>
              <span class="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-0">
                <RouterLink :to="deviceLink(sample.device_id)" class="block truncate font-mono text-xs text-sky-700 hover:underline dark:text-sky-300" :title="sample.device_id">
                  {{ shortDeviceId(sample.device_id) }}
                </RouterLink>
                <span class="block text-xs text-slate-500 dark:text-slate-400">
                  {{ t('channel-impact-example-meta', { native: sample.version_build || t('unknown'), bundle: bundleOnDevice(sample.version_name, sample.version_build), count: fmt(sample.device_count) }) }}
                </span>
              </span>
              <span class="ml-7 shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset sm:ml-0" :class="toneChip[outcomeTone(sample.outcome)]">
                {{ outcomeLabel(sample.outcome) }}
              </span>
            </li>
          </ul>
        </template>
      </section>
    </div>
  </Teleport>
</template>
