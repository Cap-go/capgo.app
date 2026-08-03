<script setup lang="ts">
import type { IncompatibilityReason, NativePackage, PackageComparison, PackageStatus } from '~/services/bundleCompatibility'
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconExternalLink from '~icons/heroicons/arrow-top-right-on-square'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconPuzzle from '~icons/heroicons/puzzle-piece'
import IconSearch from '~icons/ic/round-search?raw'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { comparePackages, hasPlatformChecksumMetadataDrift, summarizeCompatibility } from '~/services/bundleCompatibility'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

type VersionRow = Pick<Database['public']['Tables']['app_versions']['Row'], 'id' | 'name' | 'created_at' | 'manifest_count' | 'app_id'>

// Tailwind classes per status. Blue = changed, green = added, red = removed,
// gray = unchanged (the colour scheme requested for this view).
const STATUS_STYLES: Record<PackageStatus, { pill: string, accent: string }> = {
  changed: {
    pill: 'text-blue-800 bg-blue-100 dark:text-blue-200 dark:bg-blue-900',
    accent: 'border-l-4 border-blue-400 dark:border-blue-500',
  },
  added: {
    pill: 'text-emerald-800 bg-emerald-100 dark:text-emerald-200 dark:bg-emerald-900',
    accent: 'border-l-4 border-emerald-400 dark:border-emerald-500',
  },
  removed: {
    pill: 'text-red-800 bg-red-100 dark:text-red-200 dark:bg-red-900',
    accent: 'border-l-4 border-red-400 dark:border-red-500',
  },
  unchanged: {
    pill: 'text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-700',
    accent: 'border-l-4 border-transparent',
  },
}

const route = useRoute()
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const tableLoading = ref(false)
const version = ref<Database['public']['Tables']['app_versions']['Row']>()
const selectedCompareVersion = ref<VersionRow | null>(null)
const baselinePackages = ref<NativePackage[]>([])
const baselinePackagesCache = ref<Record<number, NativePackage[]>>({})
const compareRequestId = ref(0)
const search = ref('')

const nativePackages = computed<NativePackage[]>(() => {
  if (!version.value?.native_packages)
    return []
  return (version.value.native_packages as unknown as NativePackage[]) ?? []
})

const compareVersionId = computed(() => selectedCompareVersion.value?.id ?? null)

// The viewed bundle is the candidate (what would ship OTA); the picked bundle is
// the installed baseline. This matches the CLI `bundle compatibility` direction.
const comparisons = computed<PackageComparison[]>(() => {
  if (!compareVersionId.value)
    return []
  return comparePackages(nativePackages.value, baselinePackages.value)
})

const searchLower = computed(() => search.value.trim().toLowerCase())

function matchesPackageSearch(name: string, ...versions: Array<string | undefined>) {
  if (!searchLower.value)
    return true
  if (name.toLowerCase().includes(searchLower.value))
    return true
  return versions.some(version => version?.toLowerCase().includes(searchLower.value))
}

const displayComparisons = computed(() => {
  if (!searchLower.value)
    return comparisons.value
  return comparisons.value.filter(entry => matchesPackageSearch(
    entry.name,
    entry.candidateVersion,
    entry.baselineVersion,
  ))
})

const displayNativePackages = computed(() => {
  if (!searchLower.value)
    return nativePackages.value
  return nativePackages.value.filter(pkg => matchesPackageSearch(pkg.name, pkg.version))
})

const compatibilitySummary = computed(() => summarizeCompatibility(comparisons.value))

const statusCounts = computed(() => {
  const counts: Record<PackageStatus, number> = { changed: 0, added: 0, removed: 0, unchanged: 0 }
  for (const entry of comparisons.value)
    counts[entry.status] += 1
  return counts
})

const uniqueVersionsCount = computed(() => new Set(nativePackages.value.map(pkg => pkg.version)).size)

const sameVersionChecksumChanges = computed(() => comparisons.value.some((entry) => {
  const isSameVersion = entry.status === 'changed'
    && !!entry.baselineVersion
    && !!entry.candidateVersion
    && entry.baselineVersion === entry.candidateVersion
  if (!isSameVersion)
    return false

  return platformChecksumDiffs(entry).length > 0
}))

// One-sided iOS/Android checksum fields: usually Capgo CLI upgrade/downgrade metadata,
// not a real native code change. Surface that so users don't treat it as incompatible.
const cliPlatformChecksumMetadataDrift = computed(() =>
  compareVersionId.value ? hasPlatformChecksumMetadataDrift(comparisons.value) : false,
)

const cliChecksumHint = computed(() => {
  if (cliPlatformChecksumMetadataDrift.value)
    return t('dependencies-cli-checksum-metadata-hint')
  if (sameVersionChecksumChanges.value)
    return t('dependencies-same-version-changed-hint')
  return ''
})

const compareStatusMessage = computed(() => {
  if (!nativePackages.value.length)
    return ''
  if (compareVersionId.value && tableLoading.value)
    return t('loading')
  if (!compareVersionId.value)
    return t('dependencies-status-full')
  const compareName = selectedCompareVersion.value?.name ?? t('unknown')
  if (baselinePackages.value.length === 0)
    return t('dependencies-status-compare-empty', { bundle: compareName })
  // In comparison mode the verdict banner already names the baseline bundle, so
  // a separate "comparing against ..." line would be redundant.
  return ''
})

// Reason → human label, mirroring the CLI's getCompatibilityDetails messages.
function reasonLabel(reason: IncompatibilityReason): string {
  switch (reason) {
    case 'new_plugin':
      return t('compat-reason-new-plugin')
    case 'removed_plugin':
      return t('compat-reason-removed-plugin')
    case 'version_mismatch':
      return t('compat-reason-version-mismatch')
    case 'requested_version_changed':
      return t('compat-reason-requested-version-changed')
    case 'ios_code_changed':
      return t('compat-reason-ios-changed')
    case 'android_code_changed':
      return t('compat-reason-android-changed')
    case 'both_platforms_changed':
      return t('compat-reason-both-changed')
    default:
      return reason
  }
}

function hideHash(hash?: string) {
  if (!hash)
    return ''
  if (hash.length <= 12)
    return hash
  return `${hash.slice(0, 6)}...${hash.slice(-6)}`
}

interface PlatformChecksumDiff {
  platform: 'iOS' | 'Android'
  baseline: string
  candidate: string
}

function isSameVersion(entry: PackageComparison): boolean {
  return entry.status === 'changed'
    && !!entry.baselineVersion
    && !!entry.candidateVersion
    && entry.baselineVersion === entry.candidateVersion
}

function isVersionMismatch(entry: PackageComparison): boolean {
  return entry.reasons.includes('version_mismatch')
}

function requestedVersionRangeChanged(entry: PackageComparison): boolean {
  return entry.reasons.includes('requested_version_changed')
}

function platformChecksumDiffs(entry: PackageComparison): PlatformChecksumDiff[] {
  const diffs: PlatformChecksumDiff[] = []

  if (entry.baselineIosChecksum && entry.candidateIosChecksum && entry.baselineIosChecksum !== entry.candidateIosChecksum) {
    diffs.push({
      platform: 'iOS',
      baseline: entry.baselineIosChecksum,
      candidate: entry.candidateIosChecksum,
    })
  }

  if (entry.baselineAndroidChecksum && entry.candidateAndroidChecksum && entry.baselineAndroidChecksum !== entry.candidateAndroidChecksum) {
    diffs.push({
      platform: 'Android',
      baseline: entry.baselineAndroidChecksum,
      candidate: entry.candidateAndroidChecksum,
    })
  }

  return diffs
}

function versionMismatchReason(entry: PackageComparison): string | null {
  if (!isVersionMismatch(entry))
    return null
  return t('dependencies-version-mismatch-with-values', {
    baseline: entry.baselineVersion ?? t('unknown'),
    candidate: entry.candidateVersion ?? t('unknown'),
  })
}

function sameVersionReason(entry: PackageComparison): string | null {
  if (isVersionMismatch(entry) || !isSameVersion(entry))
    return null
  return t('dependencies-version-text-unchanged')
}

function requestedRangeReason(entry: PackageComparison): string | null {
  if (!requestedVersionRangeChanged(entry))
    return null
  return t('dependencies-constraint-changed', {
    baseline: entry.baselineRequestedVersion ?? t('unknown'),
    candidate: entry.candidateRequestedVersion ?? t('unknown'),
  })
}

function filteredReasons(entry: PackageComparison) {
  return entry.reasons
    .filter(reason => reason !== 'version_mismatch'
      && reason !== 'requested_version_changed'
      && reason !== 'ios_code_changed'
      && reason !== 'android_code_changed'
      && reason !== 'both_platforms_changed')
    .map(reasonLabel)
}

function openNpmPackage(packageName: string) {
  window.open(`https://www.npmjs.com/package/${packageName}`, '_blank', 'noopener,noreferrer')
}

async function fetchBaselinePackages(versionId: number) {
  if (!packageId.value)
    return []
  const { data, error } = await supabase
    .from('app_versions')
    .select('id, native_packages')
    .eq('app_id', packageId.value)
    .eq('id', versionId)
    .single()

  if (error) {
    console.error('Failed to load compare dependencies', error)
    return []
  }

  return (data?.native_packages as unknown as NativePackage[]) ?? []
}

async function getVersion() {
  if (!id.value)
    return

  try {
    const { data, error } = await supabase
      .from('app_versions')
      .select()
      .eq('app_id', packageId.value)
      .eq('id', id.value)
      .single()

    if (error) {
      console.error('no version', error)
      return
    }

    version.value = data

    if (version.value?.name)
      displayStore.setBundleName(String(version.value.id), version.value.name)
    displayStore.NavTitle = version.value?.name ?? t('bundle')
  }
  catch (error) {
    console.error(error)
  }
}

function resetCompareSelection() {
  selectedCompareVersion.value = null
  baselinePackages.value = []
  tableLoading.value = false
}

// Reflect the selected baseline in the URL (?compare=<versionId>) so a
// comparison is shareable / deep-linkable. Uses replace so each dropdown change
// does not pollute browser history, and skips no-op writes.
function replaceCompareParam(value: number | null) {
  const current = route.query.compare
  const currentStr = (Array.isArray(current) ? current[0] : current) ?? undefined
  const desired = value ? String(value) : undefined
  if (currentStr === desired)
    return
  const query = { ...route.query }
  if (desired)
    query.compare = desired
  else
    delete query.compare
  // Ignore redundant-navigation rejections from vue-router.
  router.replace({ path: route.path, query }).catch(() => {})
}

// Pre-select a baseline from ?compare=<versionId> on load. Reads route.query
// imperatively (never inside a tracked scope) so it cannot retrigger init.
async function restoreCompareFromQuery() {
  const raw = route.query.compare
  if (raw == null)
    return
  const compareId = Number(Array.isArray(raw) ? raw[0] : raw)
  // Ignore a missing/self/invalid id and scrub it from the URL.
  if (!compareId || Number.isNaN(compareId) || compareId === id.value) {
    replaceCompareParam(null)
    return
  }
  // Match the picker's eligibility: a deep link must not resolve a deleted
  // bundle or one without native packages (which the picker excludes), else the
  // baseline load would coerce missing packages to [] and report every
  // dependency as newly added/incompatible. Scrub the param if it doesn't match.
  const { data, error } = await supabase
    .from('app_versions')
    .select('id, name, created_at, manifest_count, app_id')
    .eq('app_id', packageId.value)
    .eq('id', compareId)
    .eq('deleted', false)
    .not('native_packages', 'is', null)
    .maybeSingle()
  if (error || !data) {
    replaceCompareParam(null)
    return
  }
  selectedCompareVersion.value = data
}

watch(compareVersionId, async (value) => {
  const requestId = ++compareRequestId.value
  replaceCompareParam(value)
  if (!value) {
    baselinePackages.value = []
    tableLoading.value = false
    return
  }

  const cached = baselinePackagesCache.value[value]
  if (cached) {
    baselinePackages.value = cached
    tableLoading.value = false
    return
  }

  // Clear before the async gap so the summary cards / verdict never show the
  // previous baseline's counts while the new one loads.
  baselinePackages.value = []
  tableLoading.value = true
  const packages = await fetchBaselinePackages(value)
  if (requestId !== compareRequestId.value)
    return
  baselinePackagesCache.value[value] = packages
  baselinePackages.value = packages
  tableLoading.value = false
})

// Init key derived ONLY from the path params (app + bundle). Watching this
// instead of route.params/route.path means a query-only navigation — e.g. the
// ?compare write below — never retriggers page init (which would reset the
// selection and cause a flash/loop).
const bundleRouteKey = computed(() => {
  if (!route.path.includes('/bundle/') || !route.path.includes('/dependencies'))
    return null
  const params = route.params as { app?: string, bundle?: string }
  if (!params.app || !params.bundle)
    return null
  return `${params.app}::${params.bundle}`
})

watch(bundleRouteKey, async (key) => {
  if (!key)
    return
  const [app, bundle] = key.split('::')
  loading.value = true
  packageId.value = app
  id.value = Number(bundle)
  baselinePackagesCache.value = {}
  search.value = ''
  resetCompareSelection()
  await getVersion()
  // Pre-select from ?compare only after the version loads.
  if (version.value)
    await restoreCompareFromQuery()
  loading.value = false
  if (!version.value?.name)
    displayStore.NavTitle = t('bundle')
  displayStore.defaultBack = `/app/${app}/bundles`
}, { immediate: true })
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="version">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
          <!-- Header -->
          <div class="px-4 py-5 border-b border-slate-200 dark:border-slate-700 sm:px-6">
            <h3 class="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {{ t('native-dependencies') }}
            </h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ t('native-dependencies-description') }}
            </p>
          </div>

          <template v-if="nativePackages.length > 0">
            <div class="px-4 pt-4 pb-3 border-b border-slate-200 dark:border-slate-700">
              <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <BundleCompareSelect
                  v-model="selectedCompareVersion"
                  :app-id="packageId"
                  :current-version-id="id"
                  compare-mode="dependencies"
                  :label="t('dependencies-compare-label')"
                  :none-label="t('dependencies-compare-none')"
                  :latest-label="t('dependencies-compare-latest')"
                  :results-label="t('dependencies-compare-results')"
                  :search-placeholder="t('search-by-name-or-bundle-id')"
                  :no-results-label="t('no-versions-found')"
                  :disabled="loading"
                  :show-spinner="tableLoading"
                />

                <div v-if="!compareVersionId" class="grid w-full grid-cols-2 gap-4 text-right md:w-auto md:text-left">
                  <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <div class="uppercase tracking-wide">
                      {{ t('dependencies-summary-packages') }}
                    </div>
                    <div class="text-lg font-semibold text-slate-900 dark:text-white">
                      {{ nativePackages.length }}
                    </div>
                  </div>
                  <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <div class="uppercase tracking-wide">
                      {{ t('dependencies-summary-versions') }}
                    </div>
                    <div class="text-lg font-semibold text-slate-900 dark:text-white">
                      {{ uniqueVersionsCount }}
                    </div>
                  </div>
                </div>

                <div v-else-if="!tableLoading" class="grid w-full grid-cols-2 gap-3 text-right md:w-auto md:grid-cols-4 md:text-left">
                  <div class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">
                    <div class="uppercase tracking-wide">
                      {{ t('dependencies-changed-packages') }}
                    </div>
                    <div class="text-lg font-semibold text-blue-900 dark:text-blue-100">
                      {{ statusCounts.changed }}
                    </div>
                  </div>
                  <div class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    <div class="uppercase tracking-wide">
                      {{ t('dependencies-added-packages') }}
                    </div>
                    <div class="text-lg font-semibold text-emerald-900 dark:text-emerald-100">
                      {{ statusCounts.added }}
                    </div>
                  </div>
                  <div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                    <div class="uppercase tracking-wide">
                      {{ t('dependencies-removed-packages') }}
                    </div>
                    <div class="text-lg font-semibold text-red-900 dark:text-red-100">
                      {{ statusCounts.removed }}
                    </div>
                  </div>
                  <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <div class="uppercase tracking-wide">
                      {{ t('dependencies-unchanged-packages') }}
                    </div>
                    <div class="text-lg font-semibold text-slate-900 dark:text-white">
                      {{ statusCounts.unchanged }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- Compatibility verdict (only meaningful with a baseline selected) -->
              <div
                v-if="compareVersionId && !tableLoading && comparisons.length > 0"
                class="mt-3 rounded-lg border px-4 py-3"
                :class="compatibilitySummary.compatible
                  ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950'
                  : 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950'"
              >
                <div class="flex items-center gap-2">
                  <IconCheckCircle v-if="compatibilitySummary.compatible" class="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  <IconAlertCircle v-else class="w-5 h-5 text-red-600 dark:text-red-400" />
                  <span
                    class="text-sm font-semibold"
                    :class="compatibilitySummary.compatible
                      ? 'text-emerald-900 dark:text-emerald-100'
                      : 'text-red-900 dark:text-red-100'"
                  >
                    {{ compatibilitySummary.compatible
                      ? t('compat-verdict-compatible')
                      : t('compat-verdict-incompatible', { count: compatibilitySummary.incompatibleCount }) }}
                  </span>
                </div>
                <p
                  class="mt-1 text-xs"
                  :class="compatibilitySummary.compatible
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-red-700 dark:text-red-300'"
                >
                  {{ compatibilitySummary.compatible
                    ? t('compat-verdict-compatible-detail', { bundle: selectedCompareVersion?.name ?? t('unknown') })
                    : t('compat-verdict-incompatible-detail') }}
                </p>
              </div>

              <p v-if="compareStatusMessage" class="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {{ compareStatusMessage }}
              </p>
              <p
                v-if="cliChecksumHint"
                data-test="dependencies-cli-checksum-hint"
                class="mt-1 text-xs text-amber-700 dark:text-amber-300"
              >
                {{ cliChecksumHint }}
              </p>

              <div class="px-2 pb-2 relative">
                <div class="px-2 py-3">
                  <FormKit
                    v-model="search"
                    :prefix-icon="IconSearch"
                    :placeholder="t('search-by-name')"
                    :disabled="tableLoading"
                    :classes="{ outer: 'mb-0! w-full md:w-96' }"
                  />
                </div>

                <div
                  v-if="searchLower && ((compareVersionId && comparisons.length > 0 && displayComparisons.length === 0) || (!compareVersionId && nativePackages.length > 0 && displayNativePackages.length === 0))"
                  class="px-6 py-8 text-sm text-center text-slate-500 dark:text-slate-400"
                >
                  {{ t('try-a-different-search-term') }}
                </div>

                <!-- Comparison view: status-aware rows with the candidate→baseline diff -->
                <div v-else-if="compareVersionId && comparisons.length > 0 && displayComparisons.length > 0" class="overflow-x-auto">
                  <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead class="bg-gray-50 dark:bg-gray-900">
                      <tr>
                        <th scope="col" class="px-6 py-3 text-xs font-medium tracking-wider text-left text-gray-500 uppercase dark:text-gray-400">
                          {{ t('package-name') }}
                        </th>
                        <th scope="col" class="px-6 py-3 text-xs font-medium tracking-wider text-left text-gray-500 uppercase dark:text-gray-400">
                          {{ t('status') }}
                        </th>
                        <th scope="col" class="px-6 py-3 text-xs font-medium tracking-wider text-left text-gray-500 uppercase dark:text-gray-400">
                          {{ t('version') }}
                        </th>
                      </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
                      <tr
                        v-for="entry in displayComparisons"
                        :key="entry.name"
                        class="hover:bg-gray-50 dark:hover:bg-gray-700"
                        :class="STATUS_STYLES[entry.status].accent"
                      >
                        <td class="px-6 py-4 text-sm font-medium text-gray-900 whitespace-nowrap dark:text-gray-100">
                          <div class="flex items-center gap-2">
                            <IconPuzzle class="w-4 h-4 text-gray-400" />
                            {{ entry.name }}
                            <button
                              class="p-1 transition-colors rounded-md hover:bg-gray-100 dark:hover:bg-gray-600"
                              :title="t('view-on-npm')"
                              @click="openNpmPackage(entry.name)"
                            >
                              <IconExternalLink class="w-4 h-4 text-gray-400 cursor-pointer hover:text-blue-500 dark:hover:text-blue-400" />
                            </button>
                          </div>
                          <div v-if="!entry.compatible" class="mt-1 space-y-1 text-xs text-red-600 dark:text-red-400">
                            <p v-if="versionMismatchReason(entry)">
                              {{ versionMismatchReason(entry) }}
                            </p>
                            <p v-else-if="sameVersionReason(entry)" class="text-slate-600 dark:text-slate-300">
                              {{ sameVersionReason(entry) }}
                            </p>

                            <p v-if="requestedRangeReason(entry)" class="text-slate-600 dark:text-slate-300">
                              {{ requestedRangeReason(entry) }}
                            </p>

                            <p v-if="isSameVersion(entry) && platformChecksumDiffs(entry).length > 0" class="text-slate-600 dark:text-slate-300">
                              {{ t('dependencies-checksum-same-version-warning') }}
                            </p>

                            <p v-for="diff in platformChecksumDiffs(entry)" :key="`checksum-${diff.platform}`" class="text-slate-600 dark:text-slate-300">
                              <span v-if="diff.platform === 'iOS'" :title="`${diff.baseline} → ${diff.candidate}`">
                                {{ t('dependencies-checksum-diff-ios', { before: hideHash(diff.baseline), after: hideHash(diff.candidate) }) }}
                              </span>
                              <span v-else :title="`${diff.baseline} → ${diff.candidate}`">
                                {{ t('dependencies-checksum-diff-android', { before: hideHash(diff.baseline), after: hideHash(diff.candidate) }) }}
                              </span>
                            </p>

                            <p v-if="filteredReasons(entry).length > 0">
                              {{ filteredReasons(entry).join(', ') }}
                            </p>
                          </div>
                          <p
                            v-else-if="entry.platformChecksumMetadataChanged"
                            data-test="dependencies-cli-checksum-row-hint"
                            class="mt-1 text-xs text-amber-700 dark:text-amber-300"
                          >
                            {{ t('dependencies-cli-checksum-row-hint') }}
                          </p>
                        </td>
                        <td class="px-6 py-4 text-sm whitespace-nowrap">
                          <span class="px-2 py-1 text-xs font-medium rounded-full" :class="STATUS_STYLES[entry.status].pill">
                            {{ t(`dependencies-status-${entry.status}`) }}
                          </span>
                        </td>
                        <td class="px-6 py-4 text-sm text-gray-500 whitespace-nowrap dark:text-gray-400">
                          <!-- changed: old → new; added: new only; removed: old only; unchanged: single version -->
                          <span v-if="entry.status === 'changed'" class="inline-flex items-center gap-2">
                            <span class="px-2 py-1 text-xs font-medium rounded-full text-slate-600 bg-slate-100 line-through dark:text-slate-300 dark:bg-slate-700">{{ entry.baselineVersion }}</span>
                            <span class="text-slate-400">→</span>
                            <span class="px-2 py-1 text-xs font-medium rounded-full text-blue-800 bg-blue-100 dark:text-blue-200 dark:bg-blue-900">{{ entry.candidateVersion }}</span>
                          </span>
                          <span v-else-if="entry.status === 'added'" class="px-2 py-1 text-xs font-medium rounded-full text-emerald-800 bg-emerald-100 dark:text-emerald-200 dark:bg-emerald-900">
                            {{ entry.candidateVersion }}
                          </span>
                          <span v-else-if="entry.status === 'removed'" class="px-2 py-1 text-xs font-medium rounded-full text-red-800 bg-red-100 line-through dark:text-red-200 dark:bg-red-900">
                            {{ entry.baselineVersion }}
                          </span>
                          <span v-else class="px-2 py-1 text-xs font-medium rounded-full text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-700">
                            {{ entry.candidateVersion }}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- No baseline selected: plain list of this bundle's packages -->
                <div v-else-if="!compareVersionId && nativePackages.length > 0 && displayNativePackages.length > 0" class="overflow-x-auto">
                  <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead class="bg-gray-50 dark:bg-gray-900">
                      <tr>
                        <th scope="col" class="px-6 py-3 text-xs font-medium tracking-wider text-left text-gray-500 uppercase dark:text-gray-400">
                          {{ t('package-name') }}
                        </th>
                        <th scope="col" class="px-6 py-3 text-xs font-medium tracking-wider text-left text-gray-500 uppercase dark:text-gray-400">
                          {{ t('version') }}
                        </th>
                      </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
                      <tr v-for="pkg in displayNativePackages" :key="`${pkg.name}@${pkg.version}`" class="hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td class="px-6 py-4 text-sm font-medium text-gray-900 whitespace-nowrap dark:text-gray-100">
                          <div class="flex items-center gap-2">
                            <IconPuzzle class="w-4 h-4 text-gray-400" />
                            {{ pkg.name }}
                            <button
                              class="p-1 transition-colors rounded-md hover:bg-gray-100 dark:hover:bg-gray-600"
                              :title="t('view-on-npm')"
                              @click="openNpmPackage(pkg.name)"
                            >
                              <IconExternalLink class="w-4 h-4 text-gray-400 cursor-pointer hover:text-blue-500 dark:hover:text-blue-400" />
                            </button>
                          </div>
                        </td>
                        <td class="px-6 py-4 text-sm text-gray-500 whitespace-nowrap dark:text-gray-400">
                          <span class="px-2 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full dark:text-blue-200 dark:bg-blue-900">
                            {{ pkg.version }}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div
                  v-if="tableLoading"
                  class="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-900/70"
                >
                  <Spinner size="w-10 h-10" />
                </div>
              </div>
            </div>
          </template>

          <div v-else class="flex flex-col items-center justify-center px-4 py-12">
            <IconPuzzle class="w-16 h-16 mb-4 text-gray-400 dark:text-gray-500" />
            <h4 class="text-lg font-medium text-gray-900 dark:text-gray-100">
              {{ t('no-native-dependencies') }}
            </h4>
            <p class="mt-1 text-sm text-center text-gray-500 dark:text-gray-400">
              {{ t('no-native-dependencies-description') }}
            </p>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('bundle-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('bundle-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/bundles`)">
        {{ t('back-to-bundles') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
