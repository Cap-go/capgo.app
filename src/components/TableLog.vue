<script setup lang="ts">
import type { TableColumn } from './comp_def'
import type { DateRangePreset } from '~/services/dateRange'
import { FormKit } from '@formkit/vue'
import { useDebounceFn, useNow } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconDown from '~icons/ic/round-keyboard-arrow-down'
import IconFastBackward from '~icons/ic/round-keyboard-double-arrow-left'
import IconSearch from '~icons/ic/round-search?raw'
import IconSortDown from '~icons/lucide/chevron-down'
import IconSortUp from '~icons/lucide/chevron-up'
import IconSort from '~icons/lucide/chevrons-up-down'
import IconDownload from '~icons/lucide/download'
import IconFilter from '~icons/system-uicons/filtering'
import IconReload from '~icons/tabler/reload'
import DateRangePicker from '~/components/DateRangePicker.vue'
import { clampDateRange, getDateRangeForPreset, inferDateRangePreset } from '~/services/dateRange'

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
const filterDropdownOpen = ref(false)
const filterDropdownRef = ref<HTMLElement | null>(null)
const filterDropdownStyle = ref<{ top: string, left: string }>({ top: '0px', left: '0px' })

function toggleFilterDropdown() {
  if (filterDropdownOpen.value) {
    filterDropdownOpen.value = false
    return
  }
  if (filterDropdownRef.value) {
    const rect = filterDropdownRef.value.getBoundingClientRect()
    filterDropdownStyle.value = {
      top: `${rect.bottom + 4}px`,
      left: `${rect.left}px`,
    }
  }
  filterDropdownOpen.value = true
}

function handleClickOutside(event: MouseEvent) {
  if (filterDropdownOpen.value && filterDropdownRef.value && !filterDropdownRef.value.contains(event.target as Node)) {
    const dropdown = document.querySelector('.fixed.p-2.w-64.bg-white')
    if (dropdown && !dropdown.contains(event.target as Node)) {
      filterDropdownOpen.value = false
    }
  }
}

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
const rangeMode = ref<DateRangePreset>('1h')
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

  const nextFilters = Object.fromEntries(
    Object.keys(props.filters).map(key => [key, false]),
  ) as Record<string, boolean>
  shortcut.filters.forEach((filter) => {
    if (filter in nextFilters)
      nextFilters[filter] = true
  })
  emit('update:filters', nextFilters)
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
    const initial = getDateRangeForPreset('1h')
    preciseDates.value = [initial.start, initial.end]
    rangeMode.value = '1h'
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
  document.removeEventListener('click', handleClickOutside)
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
  document.addEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="pb-4 md:pb-0">
    <div class="flex flex-wrap items-start justify-between gap-2 p-3 pb-4 overflow-visible md:items-center md:flex-nowrap">
      <div class="flex h-10 md:mb-0">
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
      <div class="flex h-10 mr-2" :class="{ 'md:mr-auto': !filterText || !filterList.length }">
        <DateRangePicker
          v-model="preciseDates"
          v-model:mode="rangeMode"
          compact
          :min-date="logsMinDate"
          @apply="onRangeApply"
        />
      </div>
      <div v-if="filterText && filterList.length" ref="filterDropdownRef" class="relative h-10 mr-2 md:mr-auto">
        <button
          type="button"
          :aria-label="filterButtonLabel"
          class="d-btn d-btn-sm relative h-full min-h-10 border-gray-300 bg-white px-3 text-sm font-medium text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:hover:border-gray-600 dark:hover:bg-gray-700"
          @click="toggleFilterDropdown"
        >
          <div
            v-if="filterActivated"
            class="inline-flex absolute -top-2 -right-2 justify-center items-center w-6 h-6 text-xs font-bold text-white bg-red-500 rounded-full border-2 border-white dark:border-gray-900"
          >
            {{ filterActivated }}
          </div>
          <IconFilter class="mr-2 w-4 h-4" />
          <span class="hidden md:block">{{ filterButtonLabel }}</span>
          <IconDown class="hidden ml-2 w-4 h-4 md:block" />
        </button>
        <Teleport to="body">
          <div
            v-if="filterDropdownOpen"
            class="fixed p-2 w-64 bg-white shadow-lg rounded-lg z-9999 dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
            :style="filterDropdownStyle"
            @click.stop
          >
            <div v-if="filterShortcuts?.length" class="mb-2 border-b border-gray-200 pb-2 dark:border-gray-700">
              <button
                v-for="shortcut in filterShortcuts"
                :key="shortcut.label"
                type="button"
                class="d-btn d-btn-ghost d-btn-sm w-full justify-start px-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                @click="applyFilterShortcut(shortcut)"
              >
                {{ t(shortcut.label) }}
              </button>
            </div>
            <input
              v-model="filterSearchVal"
              type="text"
              name="log-filter-search"
              :aria-label="t('search')"
              :placeholder="t('search')"
              class="w-full px-3 py-2 mb-2 text-sm border border-gray-300 rounded-md dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              @click.stop
            >
            <ul class="max-h-64 overflow-y-auto">
              <li v-for="(f, i) in filterList" :key="i">
                <div
                  class="flex items-center p-2 rounded-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600"
                >
                  <input
                    :id="`filter-radio-example-${i}`" :checked="filters?.[f]" type="checkbox"
                    :name="`filter-radio-${i}`"
                    class="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 dark:bg-gray-700 dark:border-gray-600 dark:ring-offset-gray-800 focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 dark:focus:ring-offset-gray-800"
                    @change="
                      emit('update:filters', { ...filters, [f]: !filters?.[f] })
                    "
                  >
                  <label
                    :for="`filter-radio-example-${i}`"
                    class="ml-2 w-full text-sm font-medium text-gray-900 rounded-sm dark:text-gray-300"
                  >{{ t(f) }}</label>
                </div>
              </li>
              <li v-if="filterList.length === 0" class="p-2 text-sm text-gray-500 dark:text-gray-400 text-center">
                {{ t('no-results') }}
              </li>
            </ul>
          </div>
        </Teleport>
      </div>
      <div class="flex min-w-0 overflow-hidden md:w-auto">
        <FormKit
          v-model="searchVal"
          :placeholder="searchPlaceholder"
          :prefix-icon="IconSearch"
          enterkeyhint="send"
          :classes="{
            outer: 'mb-0! w-48 sm:w-64 md:w-96',
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
              <th v-if="col.head" :class="`${col.class} ${!col.mobile ? 'hidden md:table-cell' : ''} ${col.onClick ? 'cursor-pointer hover:underline clickable-cell' : ''}`" scope="row" class="px-1 py-1 font-medium text-gray-900 whitespace-nowrap md:py-4 md:px-6 dark:text-white" @click.stop="col.onClick ? col.onClick(elem) : () => {}">
                {{ displayValueKey(elem, col) }}
              </th>
              <td v-else-if="col.icon" :class="`${col.class} ${!col.mobile ? 'hidden md:table-cell' : ''}`" class="px-1 py-1 cursor-pointer md:py-4 md:px-6" @click.stop="col.onClick ? col.onClick(elem) : () => {}">
                <component :is="col.icon" />
              </td>
              <td v-else :class="`${col.class} ${!col.mobile ? 'hidden md:table-cell' : ''} ${col.onClick ? 'cursor-pointer hover:underline clickable-cell' : ''}`" class="px-1 py-1 md:py-4 md:px-6" @click.stop="col.onClick ? col.onClick(elem) : () => {}">
                {{ displayValueKey(elem, col) }}
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
