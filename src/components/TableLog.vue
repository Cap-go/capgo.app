<script setup lang="ts">
import type { TableColumn } from './comp_def'
import type { DateRangePreset } from '~/services/dateRange'
import { FormKit } from '@formkit/vue'
import { useDebounceFn, useNow } from '@vueuse/core'
import { computed, defineComponent, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconFastBackward from '~icons/ic/round-keyboard-double-arrow-left'
import IconSearch from '~icons/ic/round-search?raw'
import IconSortDown from '~icons/lucide/chevron-down'
import IconSortUp from '~icons/lucide/chevron-up'
import IconSort from '~icons/lucide/chevrons-up-down'
import IconDownload from '~icons/lucide/download'
import IconFilter from '~icons/system-uicons/filtering'
import IconReload from '~icons/tabler/reload'
import DateRangePicker from '~/components/DateRangePicker.vue'
import FilterModal from '~/components/FilterModal.vue'
import { createClearedFilters } from '~/composables/useFilterModal'
import { clampDateRange, getDateRangeForPreset, inferDateRangePreset, TABLE_DATE_RANGE_DEFAULT } from '~/services/dateRange'

interface Props {
  isLoading?: boolean
  exportable?: boolean
  exportLoading?: boolean
  filterText?: string
  filters?: { [key: string]: boolean }
  filterShortcuts?: { label: string, filters: string[] }[]
  range?: [Date, Date]
  searchPlaceholder?: string
  search?: string
  currentPage: number
  columns: TableColumn[]
  elementList: { [key: string]: any }[]
  appId: string
  autoReload?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits([
  'reload',
  'reset',
  'export',
  'next',
  'prev',
  'fastForward',
  'fastBackward',
  'update:search',
  'update:filters',
  'update:range',
  'update:columns',
  'update:currentPage',
])

const { t } = useI18n()
const searchVal = ref(props.search ?? '')

const filterSearchVal = ref('')
const isFilterModalOpen = ref(false)
const filterOpenButtonRef = ref<HTMLButtonElement | null>(null)
const filterModalTitleId = `${useId()}-log-filters-title`

function openFilterModal() {
  isFilterModalOpen.value = true
}

function closeFilterModal() {
  isFilterModalOpen.value = false
}

const hasFilterMenu = computed(() => Boolean(props.filterText && props.filters && Object.keys(props.filters).length))

const filterList = computed(() => {
  if (!props.filters)
    return []
  const allFilters = Object.keys(props.filters)
  if (!filterSearchVal.value)
    return allFilters
  const search = filterSearchVal.value.toLowerCase()
  return allFilters.filter(f => t(f).toLowerCase().includes(search))
})
const filterActivated = computed(() => {
  if (!props.filters)
    return 0
  return Object.keys(props.filters).reduce((acc, key) => {
    if (props.filters![key])
      acc += 1
    return acc
  }, 0)
})
const filterButtonLabel = computed(() => {
  if (!props.filterText)
    return ''
  const label = t(props.filterText)
  return filterActivated.value ? `${label} (${filterActivated.value})` : label
})
const preciseDates = ref<[Date, Date] | null>(null)
const rangeMode = ref<DateRangePreset>(TABLE_DATE_RANGE_DEFAULT)
const now = useNow({ interval: 60_000 })
const logsMinDate = computed(() => new Date(now.value.getTime() - 30 * 24 * 60 * 60 * 1000))

function clampLogsRange(start: Date, end: Date): [Date, Date] {
  const clamped = clampDateRange({ start, end }, logsMinDate.value)
  return [clamped.start, clamped.end]
}

const autoReload = computed(() => props.autoReload ?? true)

function requestReload() {
  if (autoReload.value)
    emit('reload')
}

function reloadData() {
  emit('reset')
}

function exportData() {
  emit('export')
}

function sortClick(key: number) {
  if (!props.columns[key].sortable)
    return
  let sortable = props.columns[key].sortable
  if (sortable === 'asc')
    sortable = 'desc'
  else if (sortable === 'desc')
    sortable = true
  else
    sortable = 'asc'
  const newColumns = [...props.columns]

  newColumns.forEach((col, index) => {
    if (index !== key && col.sortable && typeof col.sortable === 'string')
      newColumns[index] = { ...col, sortable: true }
  })

  newColumns[key].sortable = sortable
  emit('update:columns', newColumns)
}

function rangesEqual(a?: [Date, Date] | null, b?: [Date, Date] | null) {
  if (!a || !b)
    return a === b
  return a[0].getTime() === b[0].getTime() && a[1].getTime() === b[1].getTime()
}

watch(() => props.range, (newRange) => {
  if (!newRange) {
    if (preciseDates.value)
      preciseDates.value = null
    return
  }
  const [start, end] = clampLogsRange(new Date(newRange[0]), new Date(newRange[1]))
  if (rangesEqual([start, end], preciseDates.value))
    return
  preciseDates.value = [start, end]
  rangeMode.value = inferDateRangePreset(start, end)
}, { immediate: true })

function displayValueKey(elem: any, col: TableColumn | undefined) {
  if (!col)
    return ''
  return col.displayFunction ? col.displayFunction(elem) : elem[col.key]
}

const RenderCell = defineComponent<{
  renderer?: (item: any) => any
  item: any
}>({
  name: 'RenderCell',
  props: {
    renderer: Function as unknown as () => ((item: any) => any) | undefined,
    item: { type: Object as any, required: true },
  },
  setup(props) {
    return () => (props.renderer ? (props.renderer as any)(props.item) : null)
  },
})

async function fastBackward() {
  emit('fastBackward')
  emit('update:currentPage', props.currentPage - 1)
  emit('reload')
}

function onRangeApply(payload: { start: Date, end: Date, mode: DateRangePreset }) {
  preciseDates.value = [payload.start, payload.end]
  rangeMode.value = payload.mode
  emit('update:range', preciseDates.value)
  updateUrlParams()
  requestReload()
}

function applyFilterShortcut(shortcut: { label: string, filters: string[] }) {
  if (!props.filters)
    return

  const nextFilters = createClearedFilters(props.filters)
  shortcut.filters.forEach((filter) => {
    if (filter in nextFilters)
      nextFilters[filter] = true
  })
  emit('update:filters', nextFilters)
}

function clearAllFilters() {
  if (!props.filters)
    return
  emit('update:filters', createClearedFilters(props.filters))
}

function isShortcutActive(shortcut: { filters: string[] }) {
  if (!props.filters || !shortcut.filters.length)
    return false
  const applicable = shortcut.filters.filter(filter => filter in props.filters!)
  if (!applicable.length)
    return false
  const selected = Object.entries(props.filters).filter(([, enabled]) => enabled).map(([key]) => key)
  if (selected.length !== applicable.length)
    return false
  const selectedSet = new Set(selected)
  return applicable.every(filter => selectedSet.has(filter))
}

function updateUrlParams() {
  const params = new URLSearchParams(window.location.search)
  if (searchVal.value)
    params.set('search', searchVal.value)
  else
    params.delete('search')
  if (preciseDates.value) {
    params.set('start', preciseDates.value[0].toISOString())
    params.set('end', preciseDates.value[1].toISOString())
  }
  else {
    params.delete('start')
    params.delete('end')
  }
  props.columns.forEach((col) => {
    if (col.sortable && col.sortable !== true)
      params.set(`sort_${col.key}`, col.sortable)
    else
      params.delete(`sort_${col.key}`)
  })
  const paramsString = params.toString() ? `?${params.toString()}` : ''
  window.history.replaceState({}, '', `${window.location.pathname}${paramsString}`)
}

function loadFromUrlParams() {
  const params = new URLSearchParams(window.location.search)
  const searchParam = params.get('search')
  if (searchParam) {
    searchVal.value = searchParam
    emit('update:search', searchVal.value)
  }

  const startParam = params.get('start')
  const endParam = params.get('end')
  if (startParam && endParam) {
    const start = new Date(startParam)
    const end = new Date(endParam)
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const clamped = clampLogsRange(start, end)
      preciseDates.value = clamped
      rangeMode.value = inferDateRangePreset(clamped[0], clamped[1])
      emit('update:range', preciseDates.value)
    }
  }
  else if (!preciseDates.value) {
    const initial = getDateRangeForPreset(TABLE_DATE_RANGE_DEFAULT)
    preciseDates.value = [initial.start, initial.end]
    rangeMode.value = TABLE_DATE_RANGE_DEFAULT
  }

  const hasSortParam = props.columns.some(col => params.has(`sort_${col.key}`))
  const newColumns = props.columns.map(col => ({
    ...col,
    sortable: hasSortParam && typeof col.sortable === 'string' ? true : col.sortable,
  }))
  props.columns.forEach((col, index) => {
    const sortParam = params.get(`sort_${col.key}`)
    if (sortParam && typeof col.sortable === 'string' && (sortParam === 'asc' || sortParam === 'desc')) {
      newColumns[index].sortable = sortParam
    }
  })
  emit('update:columns', newColumns)
}

// Cleanup on unmount
onUnmounted(() => {
  const params = new URLSearchParams(window.location.search)
  params.delete('search')
  params.delete('start')
  params.delete('end')
  props.columns.forEach((col) => {
    params.delete(`sort_${col.key}`)
  })
  const paramsString = params.toString() ? `?${params.toString()}` : ''
  window.history.replaceState({}, '', `${window.location.pathname}${paramsString}`)
})

// Add watches
watch(() => props.columns, useDebounceFn(() => {
  updateUrlParams()
  requestReload()
}, 500), { deep: true })

watch(preciseDates, useDebounceFn(() => {
  updateUrlParams()
}, 500))

watch(searchVal, useDebounceFn(() => {
  updateUrlParams()
  emit('update:search', searchVal.value)
  requestReload()
}, 500))

onMounted(() => {
  loadFromUrlParams()
})
</script>

<template>
  <div class="pb-4 md:pb-0">
    <div class="flex flex-wrap items-start justify-between gap-2 p-3 pb-4 overflow-visible md:items-center md:flex-nowrap">
      <div class="flex h-10 shrink-0 md:mb-0">
        <button class="inline-flex items-center py-1.5 px-3 mr-2 text-sm font-medium text-gray-500 bg-white rounded-md border border-gray-300 dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden" type="button" @click="reloadData">
          <IconReload v-if="!isLoading" class="m-1 md:mr-2" />
          <Spinner v-else size="w-[16.8px] h-[16.8px] m-1 mr-2" />
          <span class="hidden text-sm md:block">{{ t('reload') }}</span>
        </button>
        <button
          v-if="exportable"
          class="inline-flex items-center py-1.5 px-3 mr-2 text-sm font-medium text-gray-500 bg-white rounded-md border border-gray-300 dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden"
          type="button"
          :disabled="isLoading || exportLoading"
          @click="exportData"
        >
          <IconDownload v-if="!exportLoading" class="m-1 md:mr-2" />
          <Spinner v-else size="w-[16.8px] h-[16.8px] m-1 mr-2" />
          <span class="hidden text-sm md:block">{{ t('download-csv') }}</span>
        </button>
      </div>
      <div class="flex h-10 mr-2 shrink-0" :class="{ 'md:mr-auto': !hasFilterMenu }">
        <DateRangePicker
          v-model="preciseDates"
          v-model:mode="rangeMode"
          compact
          :min-date="logsMinDate"
          @apply="onRangeApply"
        />
      </div>
      <div v-if="hasFilterMenu" class="relative h-10 mr-2 shrink-0 md:mr-auto">
        <button
          ref="filterOpenButtonRef"
          type="button"
          :aria-label="filterButtonLabel"
          :aria-expanded="isFilterModalOpen"
          aria-haspopup="dialog"
          data-test="log-table-filters-open"
          class="d-btn d-btn-sm relative h-full min-h-10 border-gray-300 bg-white px-3 text-sm font-medium text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:hover:border-gray-600 dark:hover:bg-gray-700"
          @click="openFilterModal"
        >
          <div
            v-if="filterActivated"
            class="inline-flex absolute -top-2 -right-2 justify-center items-center w-6 h-6 text-xs font-bold text-white bg-red-500 rounded-full border-2 border-white dark:border-gray-900"
          >
            {{ filterActivated }}
          </div>
          <IconFilter class="mr-2 w-4 h-4" />
          <span class="hidden md:block">{{ filterButtonLabel }}</span>
        </button>
        <FilterModal
          :open="isFilterModalOpen"
          :title="t(filterText ?? 'Filters')"
          :subtitle="t('filter-logs-modal-subtitle')"
          :title-id="filterModalTitleId"
          :clear-disabled="!filterActivated"
          :restore-focus-el="filterOpenButtonRef"
          test-id-prefix="log-table"
          @close="closeFilterModal"
          @clear="clearAllFilters"
        >
          <div v-if="filterShortcuts?.length" class="space-y-2">
            <p class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('filter-shortcuts-label') }}
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="shortcut in filterShortcuts"
                :key="shortcut.label"
                type="button"
                data-test="log-table-filter-shortcut"
                class="d-btn d-btn-sm min-h-10 border-2 border-slate-300 bg-white px-3.5 font-semibold text-slate-800 shadow-sm hover:border-azure-500 hover:bg-azure-50 hover:text-azure-700 dark:border-slate-500 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-azure-400 dark:hover:bg-slate-700"
                :class="{
                  'border-azure-500 bg-azure-50 text-azure-700 ring-2 ring-azure-500 dark:border-azure-400 dark:bg-azure-950/40 dark:text-azure-200': isShortcutActive(shortcut),
                }"
                :aria-pressed="isShortcutActive(shortcut)"
                @click="applyFilterShortcut(shortcut)"
              >
                {{ t(shortcut.label) }}
              </button>
            </div>
          </div>

          <div>
            <label for="log-filter-search" class="sr-only">{{ t('search') }}</label>
            <input
              id="log-filter-search"
              v-model="filterSearchVal"
              type="text"
              name="log-filter-search"
              :aria-label="t('search')"
              :placeholder="t('search')"
              class="w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm text-slate-900 focus:border-azure-500 focus:outline-none focus:ring-2 focus:ring-azure-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            >
          </div>

          <fieldset v-if="filterList.length" class="space-y-1">
            <legend class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {{ t('filter-options') }}
            </legend>
            <label
              v-for="f in filterList"
              :key="f"
              :for="`log-filter-option-${f}`"
              class="flex min-h-11 cursor-pointer items-center rounded-md px-2 py-2 transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <input
                :id="`log-filter-option-${f}`"
                :checked="filters?.[f]"
                type="checkbox"
                :name="`log-filter-option-${f}`"
                class="h-4 w-4 shrink-0 rounded border-gray-300 text-azure-500 focus:ring-2 focus:ring-azure-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800"
                @change="emit('update:filters', { ...filters, [f]: !filters?.[f] })"
              >
              <span class="ml-3 min-w-0 text-sm font-medium text-slate-900 dark:text-slate-200">
                {{ t(f) }}
              </span>
            </label>
          </fieldset>
          <p v-else class="py-2 text-center text-sm text-slate-500 dark:text-slate-400">
            {{ t('no-results') }}
          </p>
        </FilterModal>
      </div>
      <div class="flex min-w-0 max-w-[13rem] overflow-hidden sm:max-w-[14rem] md:max-w-[14rem] lg:max-w-[16rem] xl:max-w-xs md:w-auto">
        <FormKit
          v-model="searchVal"
          :placeholder="searchPlaceholder"
          :prefix-icon="IconSearch"
          enterkeyhint="send"
          :classes="{
            outer: 'mb-0! w-48 sm:w-52 md:w-56 lg:w-64 xl:w-80',
          }"
        />
      </div>
    </div>
    <div class="block overflow-x-auto">
      <table id="custom_table" class="w-full text-sm text-left text-gray-500 dark:text-gray-400">
        <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:text-gray-400 dark:bg-gray-700">
          <tr>
            <th v-for="(col, i) in columns" :key="i" scope="col" class="px-1 py-3 md:px-6" :class="{ 'cursor-pointer': col.sortable, 'hidden md:table-cell': !col.mobile }" @click="sortClick(i)">
              <div class="flex items-center first-letter:uppercase">
                {{ col.label }}
                <div v-if="col.sortable">
                  <IconSortUp v-if="col.sortable === 'asc'" />
                  <IconSortDown v-else-if="col.sortable === 'desc'" />
                  <IconSort v-else />
                </div>
              </div>
            </th>
          </tr>
        </thead>
        <tbody v-if="elementList.length !== 0">
          <tr
            v-for="(elem, i) in elementList" :key="i"
            class="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
          >
            <template v-for="(col, _y) in columns" :key="`${i}_${_y}`">
              <th v-if="col.head" :class="`${col.class ?? ''} ${!col.mobile ? 'hidden md:table-cell' : ''} ${col.onClick ? 'cursor-pointer hover:underline clickable-cell' : ''}`" scope="row" class="px-1 py-1 font-medium text-gray-900 whitespace-nowrap md:py-4 md:px-6 dark:text-white" @click.stop="col.onClick ? col.onClick(elem) : () => {}">
                <RenderCell v-if="col.renderFunction" :renderer="col.renderFunction" :item="elem" />
                <template v-else>
                  {{ displayValueKey(elem, col) }}
                </template>
              </th>
              <td v-else-if="col.icon" :class="`${col.class ?? ''} ${!col.mobile ? 'hidden md:table-cell' : ''}`" class="px-1 py-1 cursor-pointer md:py-4 md:px-6" @click.stop="col.onClick ? col.onClick(elem) : () => {}">
                <component :is="col.icon" />
              </td>
              <td v-else :class="`${col.class ?? ''} ${!col.mobile ? 'hidden md:table-cell' : ''} ${col.onClick ? 'cursor-pointer hover:underline clickable-cell' : ''}`" class="px-1 py-1 md:py-4 md:px-6" @click.stop="col.onClick ? col.onClick(elem) : () => {}">
                <RenderCell v-if="col.renderFunction" :renderer="col.renderFunction" :item="elem" />
                <template v-else>
                  {{ displayValueKey(elem, col) }}
                </template>
              </td>
            </template>
          </tr>
        </tbody>
        <tbody v-else-if="!isLoading && elementList.length === 0">
          <tr>
            <td :colspan="columns.length" class="px-1 py-1 text-center text-gray-500 md:py-4 md:px-6 dark:text-gray-400">
              {{ t('no_elements_found') }}
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="i in 10" :key="i" class="max-w-sm" :class="{ 'animate-pulse duration-1000': isLoading }">
            <td v-for="(col, y) in columns" :key="`${i}_${y}`" class="px-1 py-1 md:py-4 md:px-6">
              <div class="bg-gray-200 rounded-full dark:bg-gray-700 max-w-[300px]" :class="{ 'mb-4 h-2.5': col.head, 'h-2 mb-2.5': !col.head }" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav class="fixed bottom-0 left-0 z-40 flex items-center justify-between w-full p-4 bg-white md:relative md:pt-4 md:bg-transparent dark:bg-gray-900 dark:md:bg-transparent" aria-label="Table navigation">
      <button
        class="flex items-center justify-center h-10 px-4 py-2 space-x-2 text-sm font-medium transition-colors border border-gray-300 rounded-md whitespace-nowrap dark:text-white dark:border-gray-700 focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background dark:hover:bg-primary/90 hover:bg-primary/10 focus-visible:outline-hidden focus-visible:ring-ring"
        @click="fastBackward"
      >
        <IconFastBackward />
        <span>Load older</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
/* DateRangePicker owns its own theme. */
</style>
