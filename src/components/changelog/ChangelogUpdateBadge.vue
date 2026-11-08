<script setup lang="ts">
import type { ChangelogProduct } from '~/services/changelog'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconSparkles from '~icons/lucide/sparkles'
import { changelogLocation, cleanVersion, fetchLatestVersion, isNewerVersion } from '~/services/changelog'

// "vX available · What's new" next to a version the user runs (CLI, updater, plugin).
// Opens the changelog scoped to everything released since that version.
const props = defineProps<{
  product: ChangelogProduct
  current: string | null | undefined
  repo?: string | null
  /** Known latest version (e.g. from npm dist-tags); fetched from release notes when missing. */
  latest?: string | null
  /** Short hints the AI digest uses to rank what matters (e.g. "encryption", "delta"). */
  features?: string[]
  /** Show "up to date" instead of nothing when current is the latest. */
  showCurrent?: boolean
  /** Keep release notes reachable when the version check fails or is still loading. */
  showNotes?: boolean
}>()

const { t } = useI18n()
const fetchedLatest = ref<string | null>(null)
const latestVersion = computed(() => cleanVersion(props.latest) ?? fetchedLatest.value)
const hasUpdate = computed(() => isNewerVersion(latestVersion.value, props.current))
const target = computed(() => {
  // Bound the digest to the advertised version: a Capacitor 7 fleet must not be sent to 8.x notes.
  const location = changelogLocation(props.product, { since: props.current, repo: props.repo, to: latestVersion.value })
  if (props.features?.length && typeof location === 'object' && 'query' in location)
    return { ...location, query: { ...location.query, features: props.features.join(',') } }
  return location
})

watch(() => [props.product, props.repo, props.latest, cleanVersion(props.current)], async (_, __, onCleanup) => {
  let active = true
  onCleanup(() => {
    active = false
  })
  fetchedLatest.value = null
  if (cleanVersion(props.latest) || !cleanVersion(props.current))
    return
  if ((props.product === 'plugin' || props.product === 'dependency') && !props.repo)
    return
  const latest = await fetchLatestVersion(props.product, props.repo)
  if (active)
    fetchedLatest.value = latest
}, { immediate: true })
</script>

<template>
  <router-link
    v-if="hasUpdate"
    :to="target"
    class="inline-flex items-center gap-1 rounded-full bg-azure-500/10 px-2 py-0.5 text-xs font-medium text-azure-700 ring-1 ring-inset ring-azure-500/30 transition-colors hover:bg-azure-500/20 dark:text-azure-300"
    data-test="changelog-update-badge"
    @click.stop
  >
    <IconSparkles class="h-3 w-3" aria-hidden="true" />
    {{ t('changelog-update-available', { version: latestVersion }) }}
  </router-link>
  <router-link
    v-else-if="showCurrent && latestVersion && cleanVersion(current)"
    :to="changelogLocation(product, { repo })"
    class="text-xs text-slate-500 hover:text-azure-600 hover:underline dark:text-slate-400"
    @click.stop
  >
    {{ t('changelog-up-to-date-short') }}
  </router-link>
  <router-link
    v-else-if="showNotes && cleanVersion(current)"
    :to="target"
    class="text-xs text-azure-600 hover:underline dark:text-azure-300"
    data-test="changelog-notes-link"
    @click.stop
  >
    {{ t('changelog-whats-new') }}
  </router-link>
</template>
