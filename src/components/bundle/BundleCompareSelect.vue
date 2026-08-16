<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { useDebounceFn } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconDown from '~icons/ic/round-keyboard-arrow-down'
import IconSearch from '~icons/ic/round-search?raw'
import { formatLocalDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'

type VersionRow = Pick<Database['public']['Tables']['app_versions']['Row'], 'id' | 'name' | 'created_at' | 'manifest_count' | 'app_id'>
type DeployHistoryRow = Pick<Database['public']['Tables']['deploy_history']['Row'], 'channel_id' | 'version_id' | 'created_at' | 'deployed_at'>

const props = withDefaults(defineProps<{
  appId: string
  currentVersionId: number
  modelValue?: VersionRow | null
  label: string
  noneLabel: string
  latestLabel: string
  resultsLabel: string
  searchPlaceholder: string
  noResultsLabel: string
  disabled?: boolean
  showSpinner?: boolean
  compareMode?: 'manifest' | 'dependencies'
}>(), {
  modelValue: null,
  disabled: false,
  showSpinner: false,
  compareMode: 'manifest',
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: VersionRow | null): void
}>()

const { t } = useI18n()
const supabase = useSupabase()

const latestCompareVersions = ref<VersionRow[]>([])
const preferredCompareVersions = ref<VersionRow[]>([])
const compareSearchResults = ref<VersionRow[]>([])
const compareSearch = ref('')
const compareSearchLoading = ref(false)
const compareSearchRequestId = ref(0)
const latestCompareRequestId = ref(0)
let preferredCompareRequestId = 0

// Map of bundle (version) id -> names of channels currently serving that bundle
// (channels.version === bundleId). Used to badge a compare option that is live on
// a channel, e.g. the one currently deployed on "production".
const liveChannelsByVersion = ref<Map<number, string[]>>(new Map())
let liveChannelsRequestId = 0

const compareOptions = computed(() => {
  if (compareSearch.value.trim())
    return compareSearchResults.value
  const preferredIds = new Set(preferredCompareVersions.value.map(version => version.id))
  return [
    ...preferredCompareVersions.value,
    ...latestCompareVersions.value.filter(version => !preferredIds.has(version.id)),
  ]
})

const compareOptionsLabel = computed(() => {
  if (compareSearch.value.trim())
    return props.resultsLabel
  return props.latestLabel
})

function resetSearchState() {
  compareSearch.value = ''
  compareSearchRequestId.value += 1
  compareSearchResults.value = []
  compareSearchLoading.value = false
}

function selectCompareVersion(option: VersionRow | null) {
  resetSearchState()
  emit('update:modelValue', option)
  // The DaisyUI dropdown is CSS-only (opens on :focus-within), so blur the
  // active element to close it after a selection.
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement)
    document.activeElement.blur()
}

// The manifest tab compares per-file manifest entries (manifest_count), while the
// dependencies tab compares native_packages. Only offer bundles that actually carry
// the data the current tab diffs on, so gate the candidate list per mode. Deleted
// bundles are excluded — their storage may be gone (and is purged after 90 days),
// so they are not meaningful comparison targets.
function buildCompareBaseQuery() {
  const query = supabase
    .from('app_versions')
    .select('id, name, created_at, manifest_count, app_id')
    .eq('app_id', props.appId)
    .eq('deleted', false)
  return props.compareMode === 'dependencies'
    ? query.not('native_packages', 'is', null)
    : query.gt('manifest_count', 0)
}

async function loadLatestCompareVersions() {
  if (!props.appId || !props.currentVersionId) {
    latestCompareVersions.value = []
    return
  }
  const requestId = ++latestCompareRequestId.value
  const { data, error } = await buildCompareBaseQuery()
    .neq('id', props.currentVersionId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (requestId !== latestCompareRequestId.value)
    return

  if (error) {
    console.error('Failed to load latest compare versions', error)
    latestCompareVersions.value = []
    return
  }

  latestCompareVersions.value = data ?? []
}

async function loadPreferredCompareVersions() {
  const requestId = ++preferredCompareRequestId
  preferredCompareVersions.value = []
  if (!props.appId || !props.currentVersionId)
    return

  const channelIds = new Set<number>()
  const deployedAtByChannel = new Map<number, string | null>()

  const { data: currentChannels, error: currentChannelsError } = await supabase
    .from('channels')
    .select('id')
    .eq('app_id', props.appId)
    .eq('version', props.currentVersionId)

  if (requestId !== preferredCompareRequestId)
    return

  if (currentChannelsError) {
    console.error('Failed to load current channels', currentChannelsError)
  }
  else {
    for (const channel of currentChannels ?? [])
      channelIds.add(channel.id)
  }

  const { data: deployHistory, error: deployHistoryError } = await supabase
    .from('deploy_history')
    .select('channel_id, version_id, created_at, deployed_at')
    .eq('app_id', props.appId)
    .eq('version_id', props.currentVersionId)
    .order('created_at', { ascending: false })

  if (requestId !== preferredCompareRequestId)
    return

  if (deployHistoryError) {
    console.error('Failed to load deploy history for bundle', deployHistoryError)
  }
  else {
    for (const entry of deployHistory ?? []) {
      const entryTime = entry.created_at ?? entry.deployed_at ?? null
      if (!channelIds.has(entry.channel_id))
        channelIds.add(entry.channel_id)
      if (!deployedAtByChannel.has(entry.channel_id))
        deployedAtByChannel.set(entry.channel_id, entryTime)
    }
  }

  if (channelIds.size === 0)
    return

  // Fetch several recent prior deployments per channel (not just one): if the
  // most recent points to a now-deleted bundle, the deleted filter below would
  // otherwise leave the channel with no baseline. Keeping a small lookback lets
  // us fall back to the next older non-deleted deployment instead.
  const PREFERRED_LOOKBACK = 20
  const candidatesByChannel: Array<Array<{ versionId: number, deployedAt: string | null }>> = []
  for (const channelId of channelIds) {
    const cutoff = deployedAtByChannel.get(channelId)
    let query = supabase
      .from('deploy_history')
      .select('version_id, created_at, deployed_at')
      .eq('app_id', props.appId)
      .eq('channel_id', channelId)
      .neq('version_id', props.currentVersionId)

    if (cutoff)
      query = query.lt('created_at', cutoff)

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(PREFERRED_LOOKBACK)

    if (requestId !== preferredCompareRequestId)
      return

    if (error) {
      console.error('Failed to load previous deploy history', error)
      continue
    }

    const candidates = ((data ?? []) as DeployHistoryRow[]).map(entry => ({
      versionId: entry.version_id,
      deployedAt: entry.created_at ?? entry.deployed_at ?? null,
    }))
    if (candidates.length)
      candidatesByChannel.push(candidates)
  }

  if (!candidatesByChannel.length)
    return

  const uniqueIds = [...new Set(candidatesByChannel.flat().map(entry => entry.versionId))]
  const { data: versions, error } = await buildCompareBaseQuery()
    .in('id', uniqueIds)

  if (requestId !== preferredCompareRequestId)
    return

  if (error) {
    console.error('Failed to load preferred compare versions', error)
    return
  }

  const versionMap = new Map((versions ?? []).map(version => [version.id, version]))
  // Per channel, keep the most recent deployment whose bundle survived the
  // deleted filter (candidates are already ordered newest-first).
  const seen = new Set<number>()
  preferredCompareVersions.value = candidatesByChannel
    .map(candidates => candidates.find(entry => versionMap.has(entry.versionId)))
    .filter((entry): entry is { versionId: number, deployedAt: string | null } => Boolean(entry))
    .sort((a, b) => (b.deployedAt ?? '').localeCompare(a.deployedAt ?? ''))
    .filter((entry) => {
      // Dedupe: the same bundle can be the surviving pick for multiple channels.
      if (seen.has(entry.versionId))
        return false
      seen.add(entry.versionId)
      return true
    })
    .map(entry => versionMap.get(entry.versionId))
    .filter((version): version is VersionRow => Boolean(version))
}

// Load every channel for the app and index its current bundle, so any compare
// option can show which channel(s) it is live on. Channels per app are few, so a
// single unfiltered fetch is cheaper than per-option lookups.
async function loadLiveChannels() {
  const requestId = ++liveChannelsRequestId
  liveChannelsByVersion.value = new Map()
  if (!props.appId)
    return

  const { data, error } = await supabase
    .from('channels')
    .select('name, version')
    .eq('app_id', props.appId)

  if (requestId !== liveChannelsRequestId)
    return

  if (error) {
    console.error('Failed to load channel bindings', error)
    return
  }

  const map = new Map<number, string[]>()
  for (const channel of data ?? []) {
    if (channel.version == null)
      continue
    const names = map.get(channel.version) ?? []
    names.push(channel.name)
    map.set(channel.version, names)
  }
  // Sort each channel list so the compact "${names[0]} +N" badge and the tooltip
  // are deterministic regardless of the row order the database returns.
  for (const names of map.values())
    names.sort((a, b) => a.localeCompare(b))
  liveChannelsByVersion.value = map
}

function liveChannels(versionId: number): string[] {
  return liveChannelsByVersion.value.get(versionId) ?? []
}

// Compact badge text: first channel name, with a "+N" suffix when a bundle is
// live on several channels so the row stays uncluttered. The full list is in the
// title tooltip.
function liveBadgeLabel(versionId: number): string {
  const names = liveChannels(versionId)
  if (names.length === 0)
    return ''
  if (names.length === 1)
    return names[0]
  return `${names[0]} +${names.length - 1}`
}

function liveBadgeTitle(versionId: number): string {
  const names = liveChannels(versionId)
  if (names.length === 0)
    return ''
  return t('currently-live-on', { channels: names.join(', ') })
}

function escapeIlike(term: string): string {
  return term.replace(/[\\%_]/g, String.raw`\$&`)
}

async function searchCompareVersions(term: string) {
  const trimmed = term.trim()
  if (!props.appId || !trimmed) {
    compareSearchResults.value = []
    compareSearchLoading.value = false
    return
  }

  const requestId = ++compareSearchRequestId.value
  compareSearchLoading.value = true

  // Each chain must start from its own builder: the Supabase query builder is
  // mutable and returns `this`, so reusing one instance across concurrent
  // chains would leak filters between the requests.
  const namePattern = `%${escapeIlike(trimmed)}%`
  const numericId = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
  let data: VersionRow[] | null = null
  let error: unknown = null

  if (Number.isNaN(numericId)) {
    const response = await buildCompareBaseQuery()
      .neq('id', props.currentVersionId)
      .ilike('name', namePattern)
      .order('created_at', { ascending: false })
      .limit(5)

    if (requestId !== compareSearchRequestId.value)
      return

    data = response.data ?? null
    error = response.error
  }
  else {
    const [nameResponse, idResponse] = await Promise.all([
      buildCompareBaseQuery()
        .neq('id', props.currentVersionId)
        .ilike('name', namePattern)
        .order('created_at', { ascending: false })
        .limit(5),
      buildCompareBaseQuery()
        .neq('id', props.currentVersionId)
        .eq('id', numericId)
        .order('created_at', { ascending: false })
        .limit(5),
    ])

    if (requestId !== compareSearchRequestId.value)
      return

    if (nameResponse.error || idResponse.error) {
      error = nameResponse.error ?? idResponse.error
      data = null
    }
    else {
      const combined = [
        ...(nameResponse.data ?? []),
        ...(idResponse.data ?? []),
      ]
      const seenIds = new Set<number>()
      const unique = combined.filter((row) => {
        if (seenIds.has(row.id))
          return false
        seenIds.add(row.id)
        return true
      })
      data = unique.slice(0, 5)
    }
  }

  if (requestId !== compareSearchRequestId.value)
    return

  if (error) {
    console.error('Failed to search compare versions', error)
    compareSearchResults.value = []
  }
  else {
    compareSearchResults.value = data ?? []
  }
  compareSearchLoading.value = false
}

const debouncedCompareSearch = useDebounceFn((term: string) => {
  searchCompareVersions(term)
}, 400)

watch(compareSearch, (term) => {
  if (!term.trim()) {
    compareSearchRequestId.value += 1
    compareSearchResults.value = []
    compareSearchLoading.value = false
    return
  }
  debouncedCompareSearch(term)
})

watch(
  () => [props.appId, props.currentVersionId],
  async () => {
    resetSearchState()
    if (!props.appId || !props.currentVersionId) {
      latestCompareVersions.value = []
      preferredCompareVersions.value = []
      liveChannelsByVersion.value = new Map()
      return
    }
    await Promise.all([loadLatestCompareVersions(), loadPreferredCompareVersions(), loadLiveChannels()])
  },
  { immediate: true },
)
</script>

<template>
  <div class="w-full md:max-w-sm">
    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
      {{ label }}
    </label>
    <div class="flex items-center gap-2 mt-2">
      <div class="w-full d-dropdown">
        <button
          type="button"
          tabindex="0"
          class="inline-flex w-full min-w-0 items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-700 shadow-sm transition hover:border-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
          :disabled="disabled"
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="truncate min-w-0">{{ modelValue?.name ?? noneLabel }}</span>
            <span
              v-if="modelValue && liveChannels(modelValue.id).length"
              class="max-w-[10rem] shrink-0 truncate rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
              :title="liveBadgeTitle(modelValue.id)"
            >
              {{ liveBadgeLabel(modelValue.id) }}
            </span>
          </span>
          <IconDown class="w-4 h-4 shrink-0 text-slate-400" />
        </button>
        <div
          tabindex="0"
          class="mt-1 w-full d-dropdown-content d-menu rounded-lg border border-slate-200 bg-white p-2 shadow-lg z-20 dark:border-slate-700 dark:bg-slate-900"
        >
          <div class="p-2" @mousedown.prevent>
            <FormKit
              v-model="compareSearch"
              :prefix-icon="IconSearch"
              :placeholder="searchPlaceholder"
              :classes="{ outer: 'mb-0! w-full' }"
            />
          </div>
          <div class="max-h-64 overflow-y-auto">
            <button
              type="button"
              class="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              @click="selectCompareVersion(null)"
            >
              {{ noneLabel }}
            </button>
            <div class="px-3 pt-3 text-xs uppercase tracking-wide text-slate-400">
              {{ compareOptionsLabel }}
            </div>
            <button
              v-for="option in compareOptions"
              :key="option.id"
              type="button"
              class="flex w-full min-w-0 items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              @click="selectCompareVersion(option)"
            >
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate min-w-0">{{ option.name }}</span>
                <span
                  v-if="liveChannels(option.id).length"
                  class="max-w-[8rem] shrink-0 truncate rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                  :title="liveBadgeTitle(option.id)"
                >
                  {{ liveBadgeLabel(option.id) }}
                </span>
              </span>
              <span class="ml-2 shrink-0 text-xs text-slate-400">{{ option.created_at ? formatLocalDate(option.created_at) : t('unknown') }}</span>
            </button>
            <div v-if="compareSearchLoading" class="px-3 py-2 text-xs text-slate-400">
              {{ t('loading') }}
            </div>
            <div v-else-if="compareSearch && compareOptions.length === 0" class="px-3 py-2 text-xs text-slate-400">
              {{ noResultsLabel }}
            </div>
          </div>
        </div>
      </div>
      <Spinner v-if="showSpinner" size="w-5 h-5" />
    </div>
  </div>
</template>
