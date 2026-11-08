<script setup lang="ts">
import type { Tab } from '~/components/comp_def'
import type { ChangelogPlugin, ChangelogProduct, ChangelogReleasesResponse, ChangelogSectionType, DigestContext } from '~/services/changelog'
import { refDebounced } from '@vueuse/core'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconLayoutDashboard from '~icons/lucide/layout-dashboard'
import IconPackage from '~icons/lucide/package'
import IconPuzzle from '~icons/lucide/puzzle'
import IconRefreshCw from '~icons/lucide/refresh-cw'
import IconSearch from '~icons/lucide/search'
import IconTerminal from '~icons/lucide/terminal'
import IconX from '~icons/lucide/x'
import ChangelogDigestCard from '~/components/changelog/ChangelogDigestCard.vue'
import ChangelogReleaseList from '~/components/changelog/ChangelogReleaseList.vue'
import ChangelogTypeBadge from '~/components/changelog/ChangelogTypeBadge.vue'
import Spinner from '~/components/Spinner.vue'
import Tabs from '~/components/Tabs.vue'
import {
  cleanVersion,
  fetchPlugins,
  fetchReleases,
  filterReleases,
  githubRepoUrl,
  isChangelogProduct,
  isNewerVersion,
  releasesSince,
  SECTION_ORDER,
  UPDATER_PACKAGE,
} from '~/services/changelog'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const displayStore = useDisplayStore()
displayStore.NavTitle = t('changelog')
displayStore.defaultBack = '/apps'

const tabs = computed<Tab[]>(() => [
  { label: 'changelog-product-console', icon: IconLayoutDashboard, key: 'console' },
  { label: 'changelog-product-cli', icon: IconTerminal, key: 'cli' },
  { label: 'changelog-product-updater', icon: IconRefreshCw, key: 'updater' },
  { label: 'changelog-product-plugins', icon: IconPuzzle, key: 'plugin' },
  { label: 'changelog-product-dependency', icon: IconPackage, key: 'dependency' },
  { label: 'changelog-product-capacitor', icon: IconPackage, key: 'capacitor' },
])

function queryString(key: string) {
  const value = route.query[key]
  if (Array.isArray(value))
    return value[0] ?? ''
  return typeof value === 'string' ? value : ''
}

const product = computed<ChangelogProduct>(() => {
  const value = queryString('product')
  return isChangelogProduct(value) ? value : 'console'
})
const pluginRepo = computed(() => queryString('repo') || null)
const dependencyInput = ref(queryString('repo'))
watch(pluginRepo, (value) => {
  dependencyInput.value = value ?? ''
})
const since = computed(() => cleanVersion(queryString('since')))
// Optional upper bound from entry points (e.g. latest updater for the app's Capacitor major).
const targetVersion = computed(() => cleanVersion(queryString('to')))
const context = computed<DigestContext>(() => ({
  features: queryString('features').split(',').map(f => f.trim()).filter(Boolean),
  platforms: queryString('platforms').split(',').map(p => p.trim()).filter(Boolean),
}))

const search = ref(queryString('q'))
const debouncedSearch = refDebounced(search, 150)
const activeTypes = ref(new Set<ChangelogSectionType>())
const onlyNew = ref(!!since.value)
const sinceInput = ref(since.value ?? '')

const data = ref<ChangelogReleasesResponse | null>(null)
const loading = ref(false)
const loadFailed = ref(false)
const plugins = ref<ChangelogPlugin[]>([])
const pluginsLoading = ref(false)
const pluginSearch = ref('')

function setQuery(patch: Record<string, string | null>) {
  const query = { ...route.query } as Record<string, string>
  for (const [key, value] of Object.entries(patch)) {
    if (value)
      query[key] = value
    else
      delete query[key]
  }
  void router.replace({ query })
}

function selectProduct(key: string) {
  if (!isChangelogProduct(key) || key === product.value)
    return
  // A version belongs to one product: never carry "since" across tabs.
  setQuery({ product: key, repo: null, since: null, to: null, features: null, platforms: null })
}

function selectPlugin(plugin: ChangelogPlugin) {
  if (plugin.name === UPDATER_PACKAGE) {
    setQuery({ product: 'updater', repo: null, since: null, to: null })
    return
  }
  setQuery({ product: 'plugin', repo: plugin.repo, since: null, to: null })
}

async function load() {
  const currentProduct = product.value
  data.value = null
  loading.value = false
  loadFailed.value = false
  const hasRepo = currentProduct === 'plugin' || currentProduct === 'dependency'
  const repo = hasRepo ? pluginRepo.value : null
  if (hasRepo && !repo) {
    data.value = null
    return
  }
  // Never show another product's or plugin's releases while the new ones load.
  loading.value = true
  const result = await fetchReleases(currentProduct, repo)
  // Ignore a slow response for a tab the user already left.
  if (currentProduct !== product.value || (hasRepo && repo !== pluginRepo.value))
    return
  data.value = result
  loadFailed.value = !result
  loading.value = false
}

watch([product, pluginRepo], load, { immediate: true })

// Plugins tab without a repo (first visit, or back from another tab): load the catalog once,
// then open the most recently released plugin so the tab is never empty.
watch([product, pluginRepo], async ([value]) => {
  if (value !== 'plugin')
    return
  if (!plugins.value.length && !pluginsLoading.value) {
    pluginsLoading.value = true
    plugins.value = await fetchPlugins()
    pluginsLoading.value = false
  }
  if (product.value !== 'plugin' || pluginRepo.value)
    return
  const newest = plugins.value.filter(p => p.name !== UPDATER_PACKAGE).toSorted((a, b) => b.date.localeCompare(a.date))[0]
  if (newest)
    setQuery({ repo: newest.repo })
}, { immediate: true })

watch(since, (value) => {
  sinceInput.value = value ?? ''
  onlyNew.value = !!value
})

watch(debouncedSearch, (value) => {
  const q = value.trim()
  if (q !== queryString('q'))
    setQuery({ q: q || null })
})
// Back/forward or a link that changes ?q= updates the box too.
watch(() => queryString('q'), (q) => {
  if (q !== search.value.trim())
    search.value = q
})

function applySince() {
  const version = cleanVersion(sinceInput.value)
  setQuery({ since: version })
}

function toggleType(type: ChangelogSectionType) {
  const next = new Set(activeTypes.value)
  if (next.has(type))
    next.delete(type)
  else
    next.add(type)
  activeTypes.value = next
}

const allReleases = computed(() => (data.value?.releases ?? []).filter(release => !targetVersion.value || !isNewerVersion(release.version, targetVersion.value)))
const scopedReleases = computed(() => onlyNew.value && since.value ? releasesSince(allReleases.value, since.value) : allReleases.value)
const visibleReleases = computed(() => filterReleases(scopedReleases.value, debouncedSearch.value, activeTypes.value))
const typeCounts = computed(() => {
  const counts = new Map<ChangelogSectionType, number>()
  for (const release of scopedReleases.value) {
    for (const section of release.sections)
      counts.set(section.type, (counts.get(section.type) ?? 0) + section.items.length)
  }
  return SECTION_ORDER.filter(type => counts.has(type)).map(type => ({ type, count: counts.get(type)! }))
})
const resultCount = computed(() => visibleReleases.value.reduce((sum, release) => sum + release.sections.reduce((s, section) => s + section.items.length, 0), 0))
const hasFilters = computed(() => !!debouncedSearch.value.trim() || activeTypes.value.size > 0)
const digestTarget = computed(() => targetVersion.value ?? data.value?.latest ?? null)
const showDigest = computed(() => !!since.value && !!data.value && isNewerVersion(digestTarget.value, since.value))
const isUpToDate = computed(() => !!since.value && !!digestTarget.value && !isNewerVersion(digestTarget.value, since.value))
const digestKey = computed(() => [product.value, pluginRepo.value, since.value, digestTarget.value, queryString('platforms'), queryString('features')].join(':'))

const selectedPlugin = computed(() => plugins.value.find(plugin => plugin.repo === pluginRepo.value) ?? null)
const filteredPlugins = computed(() => {
  const query = pluginSearch.value.trim().toLowerCase()
  const list = plugins.value
  if (!query)
    return list
  return list.filter(plugin => plugin.name.toLowerCase().includes(query) || plugin.description.toLowerCase().includes(query))
})

const upgradeCommand = computed(() => {
  const latest = digestTarget.value
  if (!latest)
    return null
  switch (product.value) {
    case 'cli':
      return 'npx @capgo/cli@latest --version'
    case 'updater':
      return `npm i ${UPDATER_PACKAGE}@${latest} && npx cap sync`
    case 'capacitor':
      return `npm i @capacitor/core@${latest} @capacitor/android@${latest} @capacitor/ios@${latest} && npm i -D @capacitor/cli@${latest} && npx cap sync`
    case 'dependency':
      return pluginRepo.value && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pluginRepo.value) ? `npm i ${pluginRepo.value}@${latest} && npx cap sync` : null
    case 'plugin':
      return selectedPlugin.value ? `npm i ${selectedPlugin.value.name}@${latest} && npx cap sync` : null
    default:
      return null
  }
})

const productTitle = computed(() => {
  if (product.value === 'plugin')
    return selectedPlugin.value?.name ?? t('changelog-product-plugins')
  if (product.value === 'dependency')
    return pluginRepo.value ?? t('changelog-product-dependency')
  return t(`changelog-product-${product.value}-long`)
})

// The catalog is alphabetical: bring the opened plugin into view (deep links land on any of 160+).
const pluginList = useTemplateRef<HTMLUListElement>('pluginList')
watch([pluginRepo, () => plugins.value.length, pluginsLoading], async () => {
  await nextTick()
  pluginList.value?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
})

function clearFilters() {
  search.value = ''
  activeTypes.value = new Set()
}
</script>

<template>
  <div class="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
    <Tabs :tabs="tabs" :active-tab="product" no-wrap @update:active-tab="selectProduct" />
    <main class="relative flex flex-1 w-full min-h-0 overflow-hidden bg-slate-50 dark:bg-slate-800/40">
      <div data-native-scroll class="flex-1 w-full min-h-0 px-4 pt-4 pb-12 overflow-y-auto sm:px-6 md:pt-8 lg:px-8">
        <div
          class="mx-auto flex w-full max-w-6xl gap-6"
          :class="product === 'plugin' ? 'flex-col lg:flex-row' : 'flex-col'"
        >
          <!-- Plugins: searchable catalog on the left, the picked plugin's notes on the right. -->
          <aside
            v-if="product === 'plugin'"
            class="flex w-full shrink-0 flex-col gap-2 lg:sticky lg:top-0 lg:max-h-[calc(100vh-10rem)] lg:w-72"
            data-test="changelog-plugin-picker"
          >
            <label class="relative block">
              <span class="sr-only">{{ t('changelog-search-plugins') }}</span>
              <IconSearch class="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                v-model="pluginSearch"
                type="search"
                class="d-input d-input-sm w-full pl-9"
                :placeholder="t('changelog-search-plugins')"
                data-test="changelog-plugin-search"
              >
            </label>
            <p class="px-1 text-xs text-slate-500 dark:text-slate-400">
              {{ t('changelog-plugin-count', { count: plugins.length }, plugins.length) }}
            </p>
            <div v-if="pluginsLoading" class="flex justify-center py-6">
              <Spinner size="w-6 h-6" />
            </div>
            <ul v-else ref="pluginList" class="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 lg:max-h-none lg:flex-1 dark:border-white/10 dark:bg-slate-800/60">
              <li v-for="plugin in filteredPlugins" :key="plugin.name">
                <button
                  type="button"
                  class="flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-100 dark:hover:bg-white/5"
                  :class="plugin.repo === pluginRepo ? 'bg-azure-500/10 ring-1 ring-inset ring-azure-500/40' : ''"
                  :aria-current="plugin.repo === pluginRepo ? 'true' : undefined"
                  @click="selectPlugin(plugin)"
                >
                  <span class="flex w-full items-center justify-between gap-2">
                    <span class="truncate text-sm font-medium text-slate-900 dark:text-white">{{ plugin.name.replace('@capgo/', '') }}</span>
                    <span class="shrink-0 font-mono text-[11px] text-slate-500 dark:text-slate-400">{{ plugin.version }}</span>
                  </span>
                  <span class="line-clamp-1 text-xs text-slate-500 dark:text-slate-400">{{ plugin.description }}</span>
                </button>
              </li>
              <li v-if="!filteredPlugins.length" class="px-3 py-4 text-sm text-slate-500">
                {{ t('changelog-no-plugin-match') }}
              </li>
            </ul>
          </aside>

          <div class="flex min-w-0 flex-1 flex-col gap-5">
            <header class="flex flex-col gap-1">
              <h1 class="flex flex-wrap items-center gap-2 text-2xl font-bold text-slate-900 dark:text-white">
                <IconPackage v-if="product === 'plugin'" class="h-6 w-6 text-slate-400" aria-hidden="true" />
                {{ productTitle }}
                <span v-if="data?.latest" class="rounded-full bg-slate-200/70 px-2.5 py-0.5 font-mono text-sm font-medium text-slate-700 dark:bg-white/10 dark:text-slate-200">
                  v{{ data.latest }}
                </span>
              </h1>
              <p class="text-sm text-slate-500 dark:text-slate-400">
                {{ product === 'plugin' && selectedPlugin ? selectedPlugin.description : t(`changelog-product-${product}-description`) }}
              </p>
            </header>

            <form v-if="product === 'dependency'" class="flex flex-col gap-2 sm:flex-row sm:items-end" @submit.prevent="setQuery({ repo: dependencyInput.trim(), since: null, to: null })">
              <div class="flex-1">
                <label for="changelog-dependency" class="mb-1 block text-sm text-slate-600 dark:text-slate-300">{{ t('changelog-dependency-package') }}</label>
                <input id="changelog-dependency" v-model="dependencyInput" type="text" required maxlength="214" class="d-input w-full" placeholder="@capacitor/camera" pattern="(?:@[a-z0-9][a-z0-9._\-]*/)?[a-z0-9][a-z0-9._\-]*">
              </div>
              <button type="submit" class="d-btn d-btn-primary">
                {{ t('changelog-load-notes') }}
              </button>
            </form>
            <p v-if="['updater', 'plugin', 'dependency', 'capacitor'].includes(product) && showDigest" class="text-sm text-slate-600 dark:text-slate-300">
              {{ t('changelog-native-rebuild') }}
            </p>

            <ChangelogDigestCard
              v-if="showDigest && since"
              :key="digestKey"
              :product="product"
              :repo="pluginRepo"
              :from-version="since"
              :to-version="digestTarget"
              :context="context"
              :upgrade-command="upgradeCommand"
            />
            <div
              v-else-if="isUpToDate"
              class="rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/20 dark:text-emerald-200"
              data-test="changelog-up-to-date"
            >
              {{ t('changelog-up-to-date', { version: since }) }}
            </div>

            <!-- Toolbar: one search box for every release, type chips, and the "since my version" scope. -->
            <div class="sticky top-0 z-10 -mx-1 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-800/95">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label class="relative block flex-1">
                  <span class="sr-only">{{ t('changelog-search') }}</span>
                  <IconSearch class="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <input
                    v-model="search"
                    type="search"
                    class="d-input w-full pl-9"
                    :placeholder="t('changelog-search')"
                    data-test="changelog-search"
                  >
                </label>
                <form class="flex items-center gap-2" @submit.prevent="applySince">
                  <label class="text-sm whitespace-nowrap text-slate-600 dark:text-slate-300" for="changelog-since">{{ t('changelog-since') }}</label>
                  <input
                    id="changelog-since"
                    v-model="sinceInput"
                    class="d-input w-28 font-mono"
                    placeholder="1.0.0"
                    inputmode="decimal"
                    data-test="changelog-since"
                    @blur="applySince"
                  >
                  <button
                    v-if="since"
                    type="button"
                    class="d-btn d-btn-ghost d-btn-sm d-btn-square"
                    :aria-label="t('changelog-clear-since')"
                    @click="setQuery({ since: null, to: null })"
                  >
                    <IconX class="h-4 w-4" aria-hidden="true" />
                  </button>
                </form>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-for="entry in typeCounts"
                  :key="entry.type"
                  type="button"
                  class="rounded-md transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-azure-500"
                  :class="activeTypes.size && !activeTypes.has(entry.type) ? 'opacity-40 hover:opacity-80' : ''"
                  :aria-pressed="activeTypes.has(entry.type)"
                  @click="toggleType(entry.type)"
                >
                  <ChangelogTypeBadge :type="entry.type" :count="entry.count" />
                </button>
                <label v-if="since" class="ml-auto flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                  <input v-model="onlyNew" type="checkbox" class="d-toggle d-toggle-sm d-toggle-primary">
                  {{ t('changelog-only-new', { version: since }) }}
                </label>
              </div>
              <p v-if="hasFilters" class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400" data-test="changelog-result-count">
                {{ t('changelog-results', { count: resultCount, releases: visibleReleases.length }, resultCount) }}
                <button type="button" class="font-medium text-azure-600 hover:underline dark:text-azure-300" @click="clearFilters">
                  {{ t('changelog-clear-filters') }}
                </button>
              </p>
            </div>

            <p
              v-if="data?.truncated && !loading"
              class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs text-slate-500 dark:border-white/10 dark:bg-slate-800/60 dark:text-slate-400"
              data-test="changelog-truncated"
            >
              {{ t('changelog-history-truncated') }}
              <a v-if="data.repo" :href="`${githubRepoUrl(data.repo)}/releases`" target="_blank" rel="noopener noreferrer" class="font-medium text-azure-600 hover:underline dark:text-azure-300">GitHub</a>
            </p>
            <div v-if="loading" class="flex justify-center py-16">
              <Spinner size="w-10 h-10" />
            </div>
            <div v-else-if="loadFailed" class="flex flex-col items-center gap-2 py-12 text-center text-sm text-slate-500">
              <p>{{ t('changelog-load-failed') }}</p>
              <a v-if="product === 'dependency' && pluginRepo" :href="`https://www.npmjs.com/package/${encodeURIComponent(pluginRepo)}`" target="_blank" rel="noopener noreferrer" class="text-azure-600 hover:underline dark:text-azure-300">{{ t('view-on-npm') }}</a>
            </div>
            <p v-else-if="!visibleReleases.length" class="py-12 text-center text-sm text-slate-500" data-test="changelog-empty">
              {{ hasFilters ? t('changelog-no-match') : t('changelog-empty') }}
            </p>
            <div v-else class="rounded-xl border border-slate-200 bg-white px-5 dark:border-white/10 dark:bg-slate-800/60">
              <ChangelogReleaseList
                :releases="visibleReleases"
                :repo="data?.repo ?? ''"
                :query="debouncedSearch"
                :since="onlyNew ? null : since"
                :latest="data?.latest"
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

