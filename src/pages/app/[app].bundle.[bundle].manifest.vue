<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import type { Database } from '~/types/supabase.types'
import { computed, h, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { formatBytes } from '~/services/conversion'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

type ManifestEntry = Database['public']['Tables']['manifest']['Row']

type VersionRow = Pick<Database['public']['Tables']['app_versions']['Row'], 'id' | 'name' | 'created_at' | 'manifest_count' | 'app_id'>

interface ManifestDownloadSizeResult {
  totalSize: number
  knownFiles: number
  unknownFiles: number
  files: Array<{
    file_name: string | null
    file_hash: string | null
    download_url: string | null
    size?: number
    error?: string
  }>
}

const route = useRoute('/app/[app].bundle.[bundle].manifest')
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const tableLoading = ref(false)
const version = ref<Database['public']['Tables']['app_versions']['Row']>()
const manifestEntries = ref<ManifestEntry[]>([])
const selectedCompareVersion = ref<VersionRow | null>(null)
const compareManifestEntries = ref<ManifestEntry[]>([])
const compareManifestCache = ref<Record<number, ManifestEntry[]>>({})
const diffDownloadSize = ref<ManifestDownloadSizeResult | null>(null)
const diffDownloadSizeLoading = ref(false)
const diffDownloadSizeRequestId = ref(0)
const pageLoadRequestId = ref(0)
const search = ref('')
const currentPage = ref(1)
const MANIFEST_PAGE_SIZE = 1000
const compareRequestId = ref(0)
const compareVersionId = computed(() => selectedCompareVersion.value?.id ?? null)
const deltaUploadCommand = 'npx @capgo/cli@latest bundle upload --delta'
const directUpdateConfigSnippet = `{
  "plugins": {
    "CapacitorUpdater": {
      "autoUpdate": true,
      "directUpdate": "atInstall"
    }
  }
}`
const differentialsDocUrl = 'https://capgo.app/docs/live-updates/differentials/'

function getRouteParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value
}

function hideHash(hash: string) {
  if (!hash)
    return ''
  if (hash.length <= 12)
    return hash
  return `${hash.slice(0, 6)}...${hash.slice(-6)}`
}

const columns = ref<TableColumn[]>([
  {
    label: t('name'),
    key: 'file_name',
    mobile: true,
    head: true,
    class: 'max-w-[20rem]',
    renderFunction: (item: ManifestEntry) => h('span', {
      class: 'block truncate text-slate-800 dark:text-white',
      title: item.file_name,
    }, item.file_name),
  },
  {
    label: t('size'),
    key: 'file_size',
    mobile: false,
    displayFunction: (item: ManifestEntry) => {
      if (typeof item.file_size === 'number' && item.file_size > 0)
        return formatBytes(item.file_size)
      return t('metadata-not-found')
    },
  },
  {
    label: t('checksum'),
    key: 'file_hash',
    mobile: false,
    class: 'max-w-[16rem]',
    renderFunction: (item: ManifestEntry) => h('span', {
      class: 'block truncate font-mono text-xs text-slate-600 dark:text-slate-300',
      title: item.file_hash,
    }, hideHash(item.file_hash)),
  },
])

const diffEntries = computed(() => {
  if (!compareVersionId.value)
    return manifestEntries.value
  const compareMap = new Map(compareManifestEntries.value.map(entry => [entry.file_name, entry.file_hash]))
  return manifestEntries.value.filter(entry => compareMap.get(entry.file_name) !== entry.file_hash)
})

const unchangedEntries = computed(() => {
  if (!compareVersionId.value)
    return []
  const compareMap = new Map(compareManifestEntries.value.map(entry => [entry.file_name, entry.file_hash]))
  return manifestEntries.value.filter(entry => compareMap.get(entry.file_name) === entry.file_hash)
})

const summaryEntries = computed(() => (compareVersionId.value ? diffEntries.value : manifestEntries.value))
const searchLower = computed(() => search.value.trim().toLowerCase())

const displayEntries = computed(() => {
  if (!searchLower.value)
    return summaryEntries.value
  return summaryEntries.value.filter(entry => entry.file_name.toLowerCase().includes(searchLower.value) || entry.file_hash.toLowerCase().includes(searchLower.value))
})

const total = computed(() => displayEntries.value.length)

function formatSizeLabel(entries: ManifestEntry[]): string {
  if (entries.length === 0)
    return formatBytes(0)
  let totalSize = 0
  let hasSize = false
  for (const entry of entries) {
    if (typeof entry.file_size === 'number' && entry.file_size > 0) {
      totalSize += entry.file_size
      hasSize = true
    }
  }
  return hasSize ? formatBytes(totalSize) : t('metadata-not-found')
}

function formatManifestDownloadSize(result: ManifestDownloadSizeResult): string {
  if (result.files.length === 0)
    return formatBytes(0)
  if (result.knownFiles === 0)
    return t('metadata-not-found')

  const size = formatBytes(result.totalSize)
  if (result.unknownFiles > 0)
    return t('manifest-size-partial', { size, unknown: result.unknownFiles })
  return size
}

const downloadSizeLabel = computed(() => {
  if (!compareVersionId.value)
    return formatSizeLabel(diffEntries.value)
  if (diffDownloadSizeLoading.value)
    return t('loading')
  if (diffDownloadSize.value)
    return formatManifestDownloadSize(diffDownloadSize.value)
  return formatSizeLabel(diffEntries.value)
})
const unchangedSizeLabel = computed(() => formatSizeLabel(unchangedEntries.value))
const totalBundleSizeLabel = computed(() => formatSizeLabel(manifestEntries.value))

const compareStatusMessage = computed(() => {
  if (!manifestEntries.value.length)
    return ''
  if (compareVersionId.value && tableLoading.value)
    return t('loading')
  if (!compareVersionId.value)
    return t('manifest-status-full')
  const compareName = selectedCompareVersion.value?.name ?? t('unknown')
  if (compareManifestEntries.value.length === 0)
    return t('manifest-status-compare-empty', { bundle: compareName })
  if (diffEntries.value.length === 0)
    return t('manifest-diff-empty', { unchanged: unchangedEntries.value.length })
  return t('manifest-status-diff', {
    bundle: compareName,
    count: diffEntries.value.length,
    unchanged: unchangedEntries.value.length,
  })
})

async function fetchManifestEntries(versionId: number) {
  const allEntries: ManifestEntry[] = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('manifest')
      .select('id, file_name, file_hash, file_size, s3_path, app_version_id')
      .eq('app_version_id', versionId)
      .order('file_name', { ascending: true })
      .range(offset, offset + MANIFEST_PAGE_SIZE - 1)

    if (error) {
      console.error('Failed to load manifest', error)
      return []
    }

    const batch = data ?? []
    allEntries.push(...batch)

    if (batch.length < MANIFEST_PAGE_SIZE)
      break

    offset += MANIFEST_PAGE_SIZE
  }

  return allEntries
}

function isManifestDownloadSizeResult(value: unknown): value is ManifestDownloadSizeResult {
  if (!value || typeof value !== 'object')
    return false
  const result = value as ManifestDownloadSizeResult
  return typeof result.totalSize === 'number'
    && typeof result.knownFiles === 'number'
    && typeof result.unknownFiles === 'number'
    && Array.isArray(result.files)
}

async function fetchManifestDownloadSize(entries: ManifestEntry[]): Promise<ManifestDownloadSizeResult | null> {
  if (!defaultApiHost || !packageId.value || !version.value?.name)
    return null

  const response = await fetch(`${defaultApiHost}/updates/manifest_size`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app_id: packageId.value,
      device_id: '00000000-0000-0000-0000-000000000000',
      version_name: '0.0.0',
      version_build: '0.0.0',
      version_os: '18.0',
      is_emulator: false,
      is_prod: true,
      platform: 'ios',
      plugin_version: '8.47.0',
      version: version.value.name,
      version_id: id.value,
      manifest: entries.map(entry => ({
        file_name: entry.file_name,
        file_hash: entry.file_hash,
        download_url: null,
      })),
    }),
  })

  if (!response.ok)
    throw new Error(`Manifest size request failed with ${response.status}`)

  const result = await response.json()
  return isManifestDownloadSizeResult(result) ? result : null
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

async function loadManifest() {
  if (!id.value)
    return
  manifestEntries.value = await fetchManifestEntries(id.value)
}

async function reloadManifest() {
  if (!id.value)
    return
  tableLoading.value = true
  await loadManifest()
  if (compareVersionId.value) {
    const cached = compareManifestCache.value[compareVersionId.value]
    compareManifestEntries.value = cached ?? await fetchManifestEntries(compareVersionId.value)
    if (!cached)
      compareManifestCache.value[compareVersionId.value] = compareManifestEntries.value
  }
  tableLoading.value = false
}

function resetCompareSelection() {
  selectedCompareVersion.value = null
  compareManifestEntries.value = []
  diffDownloadSize.value = null
  diffDownloadSizeLoading.value = false
  diffDownloadSizeRequestId.value += 1
  tableLoading.value = false
}

watch(compareVersionId, async (value) => {
  const requestId = ++compareRequestId.value
  currentPage.value = 1
  if (!value) {
    compareManifestEntries.value = []
    tableLoading.value = false
    return
  }

  const cached = compareManifestCache.value[value]
  if (cached) {
    compareManifestEntries.value = cached
    tableLoading.value = false
    return
  }

  tableLoading.value = true
  const entries = await fetchManifestEntries(value)
  if (requestId !== compareRequestId.value)
    return
  compareManifestCache.value[value] = entries
  compareManifestEntries.value = entries
  tableLoading.value = false
})

watch([diffEntries, compareVersionId, tableLoading], async ([entries, compareId, isTableLoading]) => {
  const requestId = ++diffDownloadSizeRequestId.value
  diffDownloadSize.value = null
  if (!compareId || isTableLoading) {
    diffDownloadSizeLoading.value = false
    return
  }
  if (entries.length === 0) {
    diffDownloadSize.value = {
      totalSize: 0,
      knownFiles: 0,
      unknownFiles: 0,
      files: [],
    }
    diffDownloadSizeLoading.value = false
    return
  }

  diffDownloadSizeLoading.value = true
  try {
    const result = await fetchManifestDownloadSize(entries)
    if (requestId !== diffDownloadSizeRequestId.value)
      return
    diffDownloadSize.value = result
  }
  catch (error) {
    console.error('Failed to load manifest download size', error)
  }
  finally {
    if (requestId === diffDownloadSizeRequestId.value)
      diffDownloadSizeLoading.value = false
  }
})

watch(
  () => [route.params.app, route.params.bundle] as const,
  async ([appParam, bundleParam]) => {
    const requestId = ++pageLoadRequestId.value
    loading.value = true
    packageId.value = getRouteParam(appParam)
    id.value = Number(getRouteParam(bundleParam))
    version.value = undefined
    manifestEntries.value = []
    resetCompareSelection()
    await Promise.all([getVersion(), loadManifest()])
    if (requestId !== pageLoadRequestId.value)
      return
    loading.value = false
    const loadedVersion = version.value as Database['public']['Tables']['app_versions']['Row'] | undefined
    if (!loadedVersion?.name)
      displayStore.NavTitle = t('bundle')
    displayStore.defaultBack = `/app/${packageId.value}/bundles`
  },
  { immediate: true },
)
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="version">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
          <div class="px-4 py-5 border-b border-slate-200 dark:border-slate-700 sm:px-6">
            <h3 class="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {{ t('manifest') }}
            </h3>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {{ t('manifest-description') }}
            </p>
          </div>

          <div v-if="manifestEntries.length === 0" class="flex flex-col items-center justify-center px-4 py-12">
            <IconAlertCircle class="w-16 h-16 mb-4 text-amber-500" />
            <h4 class="text-lg font-medium text-gray-900 dark:text-gray-100">
              {{ t('no-manifest-bundle') }}
            </h4>
            <p class="mt-2 max-w-xl text-center text-sm text-slate-600 dark:text-slate-300">
              {{ t('manifest-no-manifest-body') }}
            </p>
            <div class="mt-6 w-full max-w-xl rounded-lg border border-slate-200 bg-slate-50 p-4 text-left text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              <div class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {{ t('manifest-delta-command-label') }}
              </div>
              <div class="mt-2 rounded-md bg-white px-3 py-2 font-mono text-xs text-slate-800 shadow-sm dark:bg-slate-950 dark:text-slate-100">
                {{ deltaUploadCommand }}
              </div>
              <div class="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {{ t('manifest-direct-update-config') }}
              </div>
              <pre class="mt-2 overflow-x-auto rounded-md bg-white px-3 py-2 text-xs font-mono text-slate-800 shadow-sm dark:bg-slate-950 dark:text-slate-100">{{ directUpdateConfigSnippet }}</pre>
            </div>
            <a
              class="mt-4 text-sm font-medium text-emerald-600 hover:underline dark:text-emerald-400"
              :href="differentialsDocUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ t('manifest-docs-link') }}
            </a>
          </div>

          <template v-else>
            <div class="px-4 pt-4 pb-3 border-b border-slate-200 dark:border-slate-700">
              <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <BundleCompareSelect
                  v-model="selectedCompareVersion"
                  :app-id="packageId"
                  :current-version-id="id"
                  :label="t('manifest-compare-label')"
                  :none-label="t('manifest-compare-none')"
                  :latest-label="t('manifest-compare-latest')"
                  :results-label="t('manifest-compare-results')"
                  :search-placeholder="t('search-by-name-or-bundle-id')"
                  :no-results-label="t('no-versions-found')"
                  :disabled="loading"
                  :show-spinner="tableLoading"
                />

                <!-- Summary cards: show different layout when comparing vs not -->
                <div v-if="!compareVersionId" class="grid w-full grid-cols-2 gap-4 text-right md:w-auto md:text-left">
                  <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <div class="uppercase tracking-wide">
                      {{ t('manifest-summary-files') }}
                    </div>
                    <div class="text-lg font-semibold text-slate-900 dark:text-white">
                      {{ manifestEntries.length }}
                    </div>
                  </div>
                  <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <div class="uppercase tracking-wide">
                      {{ t('size') }}
                    </div>
                    <div class="text-lg font-semibold text-slate-900 dark:text-white">
                      {{ totalBundleSizeLabel }}
                    </div>
                  </div>
                </div>

                <!-- Comparison mode: show download vs unchanged stats -->
                <div v-else class="grid w-full grid-cols-2 gap-3 text-right md:w-auto md:grid-cols-4 md:text-left">
                  <!-- To download -->
                  <div class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    <div class="uppercase tracking-wide">
                      {{ t('manifest-to-download') }}
                    </div>
                    <div class="text-lg font-semibold text-emerald-900 dark:text-emerald-100">
                      {{ diffEntries.length }} {{ t('manifest-files-short') }}
                    </div>
                    <div class="text-sm font-medium">
                      {{ downloadSizeLabel }}
                    </div>
                  </div>
                  <!-- Already cached / unchanged -->
                  <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    <div class="uppercase tracking-wide">
                      {{ t('manifest-already-cached') }}
                    </div>
                    <div class="text-lg font-semibold text-slate-900 dark:text-white">
                      {{ unchangedEntries.length }} {{ t('manifest-files-short') }}
                    </div>
                    <div class="text-sm font-medium">
                      {{ unchangedSizeLabel }}
                    </div>
                  </div>
                  <!-- Total bundle -->
                  <div class="col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 md:col-span-2">
                    <div class="uppercase tracking-wide">
                      {{ t('manifest-total-bundle') }}
                    </div>
                    <div class="text-base font-semibold text-slate-700 dark:text-slate-200">
                      {{ manifestEntries.length }} {{ t('manifest-files-short') }} · {{ totalBundleSizeLabel }}
                    </div>
                  </div>
                </div>
              </div>
              <p v-if="compareStatusMessage" class="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {{ compareStatusMessage }}
              </p>
              <p v-if="selectedCompareVersion" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ t('manifest-download-estimate-note') }}
              </p>
            </div>

            <div class="px-2 pb-2 relative">
              <DataTable
                v-model:search="search" v-model:current-page="currentPage" v-model:columns="columns"
                :total="total" :element-list="displayEntries"
                :is-loading="tableLoading"
                :search-placeholder="t('search-by-name')"
                @reload="reloadManifest"
                @reset="reloadManifest"
              />
              <div
                v-if="tableLoading"
                class="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-900/70"
              >
                <Spinner size="w-10 h-10" />
              </div>
            </div>
          </template>
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
      <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/bundles`)">
        {{ t('back-to-bundles') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
