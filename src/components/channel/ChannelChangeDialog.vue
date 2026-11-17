<script setup lang="ts">
import type { ChannelImpactOutcome, ChannelImpactPlatform, ChannelImpactResult } from '~/services/channelImpact'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconInfo from '~icons/heroicons/information-circle'
import IconWarning from '~icons/lucide/alert-triangle'
import IconAndroid from '~icons/mdi/android'
import IconApple from '~icons/mdi/apple'
import IconElectron from '~icons/mdi/electron-framework'
import { CHANNEL_CHANGE_DIALOG_ID, setRevertChoice, useChannelChangeState } from '~/composables/useChannelChangeConfirm'
import { formatImpactPercent, STRATEGY_BLOCKED_OUTCOMES } from '~/services/channelImpact'
import { useDialogV2Store } from '~/stores/dialogv2'

const { t } = useI18n()
const dialogStore = useDialogV2Store()
const { state, impact, previousBundle } = useChannelChangeState()

const open = computed(() => dialogStore.showDialog && dialogStore.dialogOptions?.id === CHANNEL_CHANGE_DIALOG_ID && !!state.options)
const options = computed(() => state.options)
const response = computed(() => state.response)
const isRevert = computed(() => options.value?.action === 'revert')
const isRollout = computed(() => options.value?.action === 'rollout')
const isBuiltinTarget = computed(() => impact.value?.target.kind === 'builtin')
const targetName = computed(() => impact.value?.target.name ?? options.value?.bundle?.name ?? '')

function fmt(value: number) {
  return value.toLocaleString()
}

type OutcomeTone = 'gets' | 'gets-risky' | 'already' | 'waits' | 'kept' | 'unknown'

const OUTCOME_ORDER: ChannelImpactOutcome[] = [
  'receive',
  'revert_to_builtin',
  'receive_below_native',
  'already_on_target',
  'blocked_major',
  'blocked_minor',
  'blocked_patch',
  'blocked_metadata',
  'blocked_misconfigured',
  'blocked_under_native',
  'blocked_platform',
  'blocked_build_type',
  'plugin_too_old',
  'unknown_native',
]

function outcomeTone(outcome: ChannelImpactOutcome): OutcomeTone {
  if (outcome === 'receive' || outcome === 'revert_to_builtin')
    return 'gets'
  if (outcome === 'receive_below_native')
    return 'gets-risky'
  if (outcome === 'already_on_target')
    return 'already'
  if (STRATEGY_BLOCKED_OUTCOMES.has(outcome))
    return 'waits'
  if (outcome === 'unknown_native')
    return 'unknown'
  return 'kept'
}

const toneBar: Record<OutcomeTone, string> = {
  'gets': 'bg-emerald-500',
  'gets-risky': 'bg-amber-400',
  'already': 'bg-sky-400',
  'waits': 'bg-violet-400',
  'kept': 'bg-slate-400 dark:bg-slate-500',
  'unknown': 'bg-slate-200 dark:bg-slate-700',
}

const toneChip: Record<OutcomeTone, string> = {
  'gets': 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900',
  'gets-risky': 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900',
  'already': 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900',
  'waits': 'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900',
  'kept': 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
  'unknown': 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:ring-slate-700',
}

function outcomeLabel(outcome: ChannelImpactOutcome, result: ChannelImpactResult | null = impact.value) {
  const native = result?.requirement?.native ?? ''
  const bundle = result?.target.name ?? ''
  if (outcome === 'already_on_target')
    return result?.target.kind === 'builtin' ? t('channel-impact-outcome-already-builtin') : t('channel-impact-outcome-already', { bundle })
  return t(`channel-impact-outcome-${outcome.replaceAll('_', '-')}`, { bundle, native })
}

const segments = computed(() => {
  const result = impact.value
  if (!result || !result.total_devices)
    return []
  return OUTCOME_ORDER
    .filter(outcome => (result.outcomes[outcome] ?? 0) > 0)
    .map(outcome => ({
      outcome,
      count: result.outcomes[outcome],
      tone: outcomeTone(outcome),
      width: `${Math.max(1.5, (result.outcomes[outcome] / result.total_devices) * 100)}%`,
      percent: formatImpactPercent(result.outcomes[outcome], result.total_devices),
    }))
})

const strategyBlocked = computed(() => {
  const result = impact.value
  if (!result)
    return 0
  return [...STRATEGY_BLOCKED_OUTCOMES].reduce((sum, outcome) => sum + (result.outcomes[outcome] ?? 0), 0)
})

const strategyExplanation = computed(() => {
  const result = impact.value
  if (!result?.requirement || !strategyBlocked.value)
    return ''
  return t(`channel-impact-why-${result.requirement.strategy}`, {
    blocked: fmt(strategyBlocked.value),
    native: result.requirement.native,
    bundle: result.target.name,
  })
})

const compatExplanation = computed(() => {
  const result = impact.value
  if (!options.value?.compatibility)
    return ''
  if (result?.requirement) {
    const { strategy, native } = result.requirement
    const builds = strategy === 'minor' || strategy === 'patch'
      ? t('channel-impact-builds-exact', { native })
      : t('channel-impact-builds-or-newer', { native })
    return t('channel-impact-compat-guarded', { builds })
  }
  return t('channel-impact-compat-unguarded')
})

const rolloutPercentText = computed(() => formatImpactPercent(options.value?.rolloutPercentageBps ?? 0, 10000))

const rolloutWaveText = computed(() => {
  const result = impact.value
  if (!isRollout.value || !result || !result.receive)
    return ''
  if (!options.value?.rolloutPercentageBps)
    return t('channel-impact-rollout-zero')
  return t('channel-impact-rollout-wave', {
    percent: rolloutPercentText.value,
    count: fmt(result.rollout_receive ?? 0),
    stable: options.value?.currentBundleName || t('channel-impact-store-version'),
  })
})

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

function choose(choice: 'previous' | 'builtin') {
  setRevertChoice(choice)
}

const receivingCount = computed(() => impact.value?.receive ?? 0)
const showImpact = computed(() => !isRevert.value || !!state.choice)
</script>

<template>
  <Teleport v-if="open && options" defer to="#dialog-v2-content">
    <div class="space-y-4 text-left" data-test="channel-change-impact">
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
        <p v-if="options.stopsRolloutTarget" class="text-xs text-amber-700 dark:text-amber-300">
          {{ t('revert-to-builtin-confirm-rollout', { target: options.stopsRolloutTarget }) }}
        </p>
      </fieldset>

      <!-- Set / promote / rollout: what the channel serves now -->
      <div v-else class="space-y-1 text-sm text-slate-600 dark:text-slate-300">
        <p>
          {{ options.currentBundleName
            ? t('channel-impact-current', { channel: options.channelName, bundle: options.currentBundleName })
            : t('channel-impact-current-builtin', { channel: options.channelName }) }}
        </p>
        <p v-if="options.replacesRolloutTarget" class="text-amber-700 dark:text-amber-300">
          {{ t('channel-impact-rollout-replaces', { bundle: options.replacesRolloutTarget }) }}
        </p>
        <p v-if="options.stopsRolloutTarget" class="text-amber-700 dark:text-amber-300">
          {{ t('revert-to-builtin-confirm-rollout', { target: options.stopsRolloutTarget }) }}
        </p>
      </div>

      <!-- Native package compatibility, explained against the update strategy -->
      <div
        v-if="options.compatibility"
        class="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100"
        data-test="channel-change-compat"
      >
        <IconWarning class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div class="min-w-0 space-y-1">
          <p class="font-semibold">
            {{ t('channel-impact-compat-title') }}
          </p>
          <p>{{ t('channel-impact-compat-packages', { bundle: options.bundle?.name ?? '', packages: options.compatibility.packages.join(', ') }) }}</p>
          <p v-if="compatExplanation">
            {{ compatExplanation }}
          </p>
        </div>
      </div>

      <p v-if="isRevert && !state.choice" class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('channel-revert-pick-prompt') }}
      </p>

      <!-- Impact -->
      <section
        v-if="showImpact"
        class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/60"
        :aria-busy="state.loading"
        data-test="channel-impact-panel"
      >
        <div v-if="state.loading" class="space-y-3" data-test="channel-impact-loading">
          <p class="text-sm text-slate-500 dark:text-slate-400">
            {{ t('channel-impact-loading') }}
          </p>
          <div class="h-7 w-2/3 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
          <div class="h-3 w-full animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
          <div class="h-16 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        </div>

        <p v-else-if="state.failed || !impact" class="text-sm text-slate-600 dark:text-slate-300" data-test="channel-impact-failed">
          {{ t('channel-impact-failed') }}
        </p>

        <div v-else class="space-y-4">
          <p v-if="response?.channel.paused" class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            {{ t('channel-impact-paused') }}
          </p>

          <p v-if="!impact.total_devices" class="text-sm text-slate-600 dark:text-slate-300" data-test="channel-impact-empty">
            {{ t('channel-impact-no-devices', { days: response?.window_days ?? 30 }) }}
          </p>

          <template v-else>
            <!-- Headline: the ratio that actually gets it -->
            <div data-test="channel-impact-headline">
              <p class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
                {{ t('channel-impact-headline-count', { count: fmt(receivingCount), total: fmt(impact.total_devices), percent: formatImpactPercent(receivingCount, impact.total_devices) }) }}
              </p>
              <p class="text-sm text-slate-600 dark:text-slate-300">
                <template v-if="isBuiltinTarget">
                  {{ t('channel-impact-headline-builtin') }}
                </template>
                <template v-else-if="isRollout">
                  {{ t('channel-impact-headline-rollout', { bundle: targetName }) }}
                </template>
                <template v-else>
                  {{ t('channel-impact-headline-gets', { bundle: targetName }) }}
                </template>
              </p>
              <p v-if="rolloutWaveText" class="mt-1 text-sm text-sky-800 dark:text-sky-200" data-test="channel-impact-rollout-wave">
                {{ rolloutWaveText }}
              </p>
            </div>

            <div class="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="img" :aria-label="segments.map(segment => `${outcomeLabel(segment.outcome)}: ${segment.percent}`).join(', ')">
              <div v-for="segment in segments" :key="segment.outcome" :class="toneBar[segment.tone]" :style="{ width: segment.width }" />
            </div>

            <ul class="space-y-1.5 text-sm" data-test="channel-impact-legend">
              <li v-for="segment in segments" :key="segment.outcome" class="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                <span class="size-2.5 shrink-0 rounded-sm" :class="toneBar[segment.tone]" aria-hidden="true" />
                <span class="min-w-0 flex-1">{{ outcomeLabel(segment.outcome) }}</span>
                <span class="tabular-nums text-slate-500 dark:text-slate-400">{{ fmt(segment.count) }} · {{ segment.percent }}</span>
              </li>
            </ul>

            <!-- Why: strategy vs store build -->
            <div v-if="strategyExplanation" class="flex gap-2 rounded-lg bg-violet-50 p-3 text-sm text-violet-900 dark:bg-violet-950/30 dark:text-violet-100" data-test="channel-impact-strategy">
              <IconInfo class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>{{ strategyExplanation }}</p>
            </div>
            <p v-if="impact.outcomes.blocked_under_native" class="text-sm text-slate-600 dark:text-slate-300">
              {{ t('channel-impact-why-under-native', { count: fmt(impact.outcomes.blocked_under_native), bundle: targetName }) }}
            </p>
            <p v-if="impact.outcomes.receive_below_native" class="text-sm text-amber-800 dark:text-amber-200">
              {{ t('channel-impact-warn-below-native', { count: fmt(impact.outcomes.receive_below_native), bundle: targetName }) }}
            </p>
            <p v-if="impact.outcomes.plugin_too_old" class="text-sm text-slate-600 dark:text-slate-300">
              {{ t('channel-impact-why-plugin-too-old', { count: fmt(impact.outcomes.plugin_too_old) }) }}
            </p>

            <!-- By store build -->
            <div v-if="impact.native_versions.length > 1" class="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              <table class="w-full text-left text-sm" data-test="channel-impact-native-table">
                <caption class="bg-slate-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                  {{ t('channel-impact-by-store-build') }}
                </caption>
                <thead class="sr-only">
                  <tr>
                    <th scope="col">
                      {{ t('channel-impact-store-build') }}
                    </th>
                    <th scope="col">
                      {{ t('devices') }}
                    </th>
                    <th scope="col">
                      {{ t('channel-impact-result') }}
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                  <tr v-for="native in impact.native_versions" :key="`${native.platform}-${native.version_build}`">
                    <td class="px-3 py-1.5 whitespace-nowrap">
                      <span class="inline-flex items-center gap-1.5 text-slate-800 dark:text-slate-100">
                        <component :is="platformIcon(native.platform)" v-if="platformIcon(native.platform)" class="size-4 text-slate-500" aria-hidden="true" />
                        <span class="sr-only">{{ platformLabel(native.platform) }}</span>
                        <span class="font-mono">{{ native.version_build || t('unknown') }}</span>
                      </span>
                    </td>
                    <td class="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {{ fmt(native.device_count) }}
                    </td>
                    <td class="px-3 py-1.5">
                      <span class="inline-flex rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset" :class="toneChip[outcomeTone(native.outcome)]">
                        {{ outcomeLabel(native.outcome) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Real example devices -->
            <div v-if="response?.samples_included && impact.samples.length" data-test="channel-impact-examples">
              <h4 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {{ t('channel-impact-examples') }}
              </h4>
              <ul class="space-y-1.5">
                <li
                  v-for="sample in impact.samples"
                  :key="sample.device_id"
                  class="flex flex-col gap-1 rounded-lg border border-slate-200 px-3 py-2 sm:flex-row sm:items-center sm:gap-3 dark:border-slate-700"
                >
                  <span class="flex min-w-0 flex-1 items-center gap-2">
                    <component :is="platformIcon(sample.platform)" v-if="platformIcon(sample.platform)" class="size-4 shrink-0 text-slate-500" aria-hidden="true" />
                    <span class="sr-only">{{ platformLabel(sample.platform) }}</span>
                    <span class="min-w-0">
                      <RouterLink :to="deviceLink(sample.device_id)" class="block truncate font-mono text-xs text-sky-700 hover:underline dark:text-sky-300" :title="sample.device_id">
                        {{ shortDeviceId(sample.device_id) }}
                      </RouterLink>
                      <span class="block text-xs text-slate-500 dark:text-slate-400">
                        {{ t('channel-impact-example-meta', { native: sample.version_build || t('unknown'), bundle: bundleOnDevice(sample.version_name, sample.version_build) }) }}
                        <template v-if="sample.device_count > 1"> · {{ t('channel-impact-example-similar', { count: fmt(sample.device_count) }) }}</template>
                      </span>
                    </span>
                  </span>
                  <span class="inline-flex self-start rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset sm:self-center" :class="toneChip[outcomeTone(sample.outcome)]">
                    {{ outcomeLabel(sample.outcome) }}
                  </span>
                </li>
              </ul>
            </div>
            <p v-else-if="response && !response.samples_included" class="text-xs text-slate-500 dark:text-slate-400">
              {{ t('channel-impact-examples-hidden') }}
            </p>
          </template>

          <p v-if="impact.total_devices" class="text-xs text-slate-500 dark:text-slate-400" data-test="channel-impact-footnote">
            {{ t('channel-impact-based-on', { total: fmt(response?.total_devices ?? 0), days: response?.window_days ?? 30 }) }}
            <template v-if="response?.truncated">
              {{ t('channel-impact-truncated') }}
            </template>
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
