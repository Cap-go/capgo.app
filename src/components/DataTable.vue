<script setup lang="ts">
import type { TableColumn } from './comp_def'
import { FormKit } from '@formkit/vue'
import { useDebounceFn } from '@vueuse/core'
import DOMPurify from 'dompurify'
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useId,
  useSlots,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import IconTrash from '~icons/heroicons/trash'
import IconPrev from '~icons/ic/round-keyboard-arrow-left'
import IconNext from '~icons/ic/round-keyboard-arrow-right'
import IconFastBackward from '~icons/ic/round-keyboard-double-arrow-left'
import IconFastForward from '~icons/ic/round-keyboard-double-arrow-right'
import IconSearch from '~icons/ic/round-search?raw'
import plusOutline from '~icons/ion/add-outline'
import IconSortDown from '~icons/lucide/chevron-down'
import IconSortUp from '~icons/lucide/chevron-up'
import IconSort from '~icons/lucide/chevrons-up-down'
import IconDownload from '~icons/lucide/download'
import IconFilter from '~icons/system-uicons/filtering'
import IconReload from '~icons/tabler/reload'
import FilterModal from '~/components/FilterModal.vue'
import { RenderCell } from '~/components/RenderCell'
import { createClearedFilters } from '~/composables/useFilterModal'

interface Props {
  isLoading?: boolean
  filterText?: string
  filters?: { [key: string]: boolean }
  filterLabels?: { [key: string]: string }
  /** Extra active filters contributed by the filter-extras slot (e.g. selects). */
  extraFilterCount?: number
  searchPlaceholder?: string
  showAdd?: boolean
  addDisabled?: boolean
  addTooltip?: string
  addButtonTestId?: string
  exportable?: boolean
  exportLoading?: boolean
  search?: string
  total: number
  /** Fixed page size used for last-page / next calculations. Prefer this over inferring from the current page length. */
  offset?: number
  currentPage: number
  columns: TableColumn[]
  elementList: { [key: string]: any }[]
  massSelect?: boolean
  autoReload?: boolean
  mobileFixedPagination?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  autoReload: true,
  mobileFixedPagination: true,
  extraFilterCount: 0,
  exportable: false,
  exportLoading: false,
})
const emit = defineEmits([
  'add',
  'reload',
  'reset',
  'next',
  'prev',
  'fastForward',
  'fastBackward',
  'update:search',
  'update:filters',
  'update:columns',
  'update:currentPage',
  'plusClick',
  'selectRow',
  'massDelete',
  'clearExtraFilters',
  'export',
])
const isFilterModalOpen = ref(false)
const filterOpenButtonRef = ref<HTMLButtonElement | null>(null)
const filterModalTitleId = `${useId()}-filters-title`
const addTooltipId = `${useId()}-add-tooltip`
const exportMenuId = `${useId()}-export-menu`
const exportMenuOpen = ref(false)
const exportTriggerRef = ref<HTMLButtonElement | null>(null)

function focusExportTrigger() {
  if (props.exportLoading)
    return
  exportTriggerRef.value?.focus()
}

function closeExportMenu() {
  exportMenuOpen.value = false
  nextTick(focusExportTrigger)
}

function toggleExportMenu() {
  if (exportMenuOpen.value)
    closeExportMenu()
  else
    exportMenuOpen.value = true
}

function onExportFocusOut(event: FocusEvent) {
  const root = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (!root || (next && root.contains(next)))
    return
  nextTick(() => {
    if (!root.contains(document.activeElement))
      exportMenuOpen.value = false
  })
}

function exportTable(format: 'csv' | 'json') {
  closeExportMenu()
  emit('export', format)
}

watch(() => props.exportLoading, (loading, wasLoading) => {
  if (wasLoading && !loading)
    nextTick(focusExportTrigger)
})
const slots = useSlots()
const { t } = useI18n()
const searchVal = ref(props.search ?? '')
const pendingReset = ref(false)
const pendingAdd = ref(false)
// const sorts = ref<TableSort>({})
// get columns from elementList

// Page size must stay fixed across pages. Inferring it from the current page's
// row count breaks last-page / next controls when the final page is short
// (common after deletes).
const pageSize = computed(() => {
  if (props.offset && props.offset > 0)
    return props.offset
  if (!props.elementList || props.elementList.length === 0)
    return 1
  return props.elementList.length
})

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / pageSize.value)))

const selectedRows = ref<boolean[]>(props.elementList.map(_ => false))
const previousSelectedRow = ref<number | null>(null)

const filterList = computed(() => {
  if (!props.filters)
    return []
  return Object.keys(props.filters)
})
const filterActivated = computed(() => {
  const booleanCount = props.filters
    ? Object.keys(props.filters).reduce((acc, key) => {
        if (props.filters![key])
          acc += 1
        return acc
      }, 0)
    : 0
  return booleanCount + (props.extraFilterCount ?? 0)
})
const hasActiveViewFilters = computed(() => Boolean(searchVal.value.trim()) || filterActivated.value > 0)

const showFilterMenu = computed(() =>
  Boolean(props.filterText && (filterList.value.length || slots['filter-extras'])),
)

function getFilterLabel(filter: string) {
  return props.filterLabels?.[filter] ?? t(filter)
}

function openFilterModal() {
  isFilterModalOpen.value = true
}

function closeFilterModal() {
  isFilterModalOpen.value = false
}

const debouncedReload = useDebounceFn(() => {
  emit('reload')
}, 1000)

function clearAllFilters() {
  // Emit a new filters object so DataTable's filters watcher performs one reload.
  // Extra filters are cleared without scheduling a second reload.
  if (props.filters)
    emit('update:filters', createClearedFilters(props.filters))
  emit('clearExtraFilters')
}

function clearViewFilters() {
  searchVal.value = ''
  emit('update:search', '')
  emit('update:currentPage', 1)
  clearAllFilters()
  if (props.autoReload !== false)
    debouncedReload()
}

function sortClick(key: number) {
  if (!props.columns[key].sortable)
    return
  let sortable = props.columns[key].sortable
  if (sortable === 'asc')
    sortable = 'desc'
  else if (sortable === 'desc')
    sortable = true
  else sortable = 'asc'

  const newColumns = [...props.columns]

  // Reset all other columns' sorting
  newColumns.forEach((col, index) => {
    if (index !== key && col.sortable && typeof col.sortable === 'string') {
      // Reset to true (sortable but not actively sorted)
      newColumns[index] = { ...col, sortable: true }
    }
  })

  // Set the clicked column's sorting
  newColumns[key].sortable = sortable
  emit('update:columns', newColumns)
}

function updateUrlParams() {
  const params = new URLSearchParams(window.location.search)
  if (searchVal.value)
    params.set('search', searchVal.value)
  else params.delete('search')
  if (props.filters) {
    params.delete('filter')
    Object.entries(props.filters).forEach(([key, value]) => {
      if (value)
        params.append('filter', key)
    })
  }
  if (props.currentPage)
    params.set('page', props.currentPage.toString())
  else params.delete('page')
  props.columns.forEach((col) => {
    if (col.sortable && col.sortable !== true)
      params.set(`sort_${col.key}`, col.sortable)
    else params.delete(`sort_${col.key}`)
  })
  const paramsString = params.toString() ? `?${params.toString()}` : ''
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${paramsString}`,
  )
}

const isSelectAllEnabled = computed(() => {
  return props.massSelect && selectedRows.value.find(Boolean)
})

function loadFromUrlParams() {
  const params = new URLSearchParams(window.location.search)
  const searchParam = params.get('search')
  if (searchParam && searchParam !== searchVal.value) {
    searchVal.value = searchParam
    emit('update:search', searchVal.value)
  }
  const pageParam = params.get('page')
  if (pageParam && pageParam !== props.currentPage.toString()) {
    const page = Number.parseInt(pageParam, 10)
    if (!Number.isNaN(page) && page !== props.currentPage) {
      emit('update:currentPage', page)
    }
  }
  const filterParams = params.getAll('filter')
  if (props.filters && filterParams.length > 0) {
    const newFilters = { ...props.filters }
    Object.keys(newFilters).forEach((key) => {
      newFilters[key] = filterParams.includes(key)
    })
    if (JSON.stringify(newFilters) !== JSON.stringify(props.filters)) {
      emit('update:filters', newFilters)
    }
  }
  const newColumns = [...props.columns]
  props.columns.forEach((col) => {
    const sortParam = params.get(`sort_${col.key}`)
    if (
      sortParam
      && col.sortable
      && (sortParam === 'asc' || sortParam === 'desc')
    ) {
      newColumns[props.columns.indexOf(col)].sortable = sortParam
    }
  })
  if (newColumns.length > 0) {
    emit('update:columns', newColumns)
  }
}

// Cleanup on unmount
onUnmounted(() => {
  const params = new URLSearchParams(window.location.search)
  // Remove our specific parameters
  params.delete('search')
  params.delete('page')
  params.delete('filter')
  props.columns.forEach((col) => {
    params.delete(`sort_${col.key}`)
  })
  const paramsString = params.toString() ? `?${params.toString()}` : ''
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${paramsString}`,
  )
})

onMounted(() => {
  loadFromUrlParams()
})

const debouncedUpdateUrlParams = useDebounceFn(() => {
  updateUrlParams()
}, 1000)

const debouncedSearch = useDebounceFn(() => {
  emit('update:search', searchVal.value)
}, 1000)

const hasRunInitialFilterSync = ref(false)
const hasLoadingCycleCompleted = ref(false)
const shouldShowRows = computed(
  () => !props.isLoading && props.elementList.length !== 0,
)
const shouldShowEmptyState = computed(
  () =>
    !props.isLoading
    && props.elementList.length === 0
    && hasLoadingCycleCompleted.value,
)
const shouldShowSkeleton = computed(
  () => !shouldShowRows.value && !shouldShowEmptyState.value,
)

watch(
  () => props.columns,
  () => {
    debouncedUpdateUrlParams()
    if (props.autoReload === false)
      return
    debouncedReload()
  },
  { deep: true },
)

watch(
  () => props.filters,
  () => {
    debouncedUpdateUrlParams()
    if (!hasRunInitialFilterSync.value) {
      hasRunInitialFilterSync.value = true
      if (props.autoReload === false)
        return
    }
    if (props.autoReload === false)
      return
    debouncedReload()
  },
  { deep: true, immediate: true },
)

watch(searchVal, () => {
  debouncedSearch()
  debouncedUpdateUrlParams()
  if (props.autoReload === false)
    return
  debouncedReload()
})

watch(
  () => props.currentPage,
  () => {
    debouncedUpdateUrlParams()
    if (props.autoReload === false)
      return
    debouncedReload()
  },
)

watch(
  () => props.isLoading,
  (loading, _previousLoading) => {
    if (!loading) {
      pendingReset.value = false
      pendingAdd.value = false
      hasLoadingCycleCompleted.value = true
    }
  },
  { immediate: true },
)

watch(
  () => props.elementList,
  (list) => {
    if (list.length > 0)
      hasLoadingCycleCompleted.value = true
  },
  { immediate: true },
)

function displayValueKey(elem: any, col: TableColumn | undefined) {
  if (!col)
    return ''
  const text = col.displayFunction ? col.displayFunction(elem) : elem[col.key]
  if (col.sanitizeHtml)
    return DOMPurify.sanitize(text)
  return text
}

function getActionTitle(action: NonNullable<TableColumn['actions']>[number], elem: any): string {
  if (!action.title)
    return ''
  return typeof action.title === 'function' ? action.title(elem) : action.title
}

function isActionDisabled(action: NonNullable<TableColumn['actions']>[number], elem: any): boolean {
  return Boolean(action.disabled && action.disabled(elem))
}

function tooltipIdFor(rowIndex: number, actionIndex: number): string {
  return `datatable-action-tooltip-${rowIndex}-${actionIndex}`
}

const displayElemRange = computed(() => {
  if (props.elementList.length === 0)
    return '0-0'
  const begin = (props.currentPage - 1) * pageSize.value
  const end = begin + props.elementList.length
  return `${begin}-${end}`
})

function canNext() {
  return props.currentPage < totalPages.value
}
function canPrev() {
  return props.currentPage > 1
}

async function next() {
  if (canNext()) {
    emit('next')
    emit('update:currentPage', props.currentPage + 1)
  }
}
async function fastForward() {
  if (canNext()) {
    emit('fastForward')
    emit('update:currentPage', totalPages.value)
  }
}
async function prev() {
  if (canPrev()) {
    emit('prev')
    emit('update:currentPage', props.currentPage - 1)
  }
}
async function fastBackward() {
  if (canPrev()) {
    emit('fastBackward')
    emit('update:currentPage', 1)
  }
}

function handleResetClick() {
  pendingReset.value = true
  emit('reset')
  // Fallback: clear after two frames if parent doesn't toggle isLoading
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!props.isLoading)
        pendingReset.value = false
    })
  })
}

function handleAddClick() {
  if (props.addDisabled)
    return

  pendingAdd.value = true
  emit('add')
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!props.isLoading)
        pendingAdd.value = false
    })
  })
}
watch(
  () => props.elementList,
  (list) => {
    selectedRows.value = list.map(() => false)
    previousSelectedRow.value = null
  },
  { immediate: true },
)
async function handleCheckboxClick(i: number, e: MouseEvent) {
  if (e.shiftKey && previousSelectedRow.value !== null) {
    for (
      let y = Math.min(previousSelectedRow.value, i);
      y <= Math.max(previousSelectedRow.value, i);
      y++
    ) {
      if (i > previousSelectedRow.value && y === previousSelectedRow.value)
        continue

      selectedRows.value[y] = !selectedRows.value[y]
    }
    emit('selectRow', selectedRows.value)
  }
  else {
    selectedRows.value[i] = !selectedRows.value[i]
    emit('selectRow', selectedRows.value)
  }
  previousSelectedRow.value = i
}

function getSkeletonWidth(columnIndex?: number) {
  // Count visible columns (mobile-friendly columns on mobile, all on desktop)
  const visibleColumns = props.columns.filter(col => col.mobile !== false)
  const totalVisibleColumns = visibleColumns.length
  const hasMassSelect = props.massSelect

  if (columnIndex === undefined) {
    // Mass select column - tiny fixed width for checkbox
    return '60px'
  }

  // Data columns - distribute remaining width equally
  const remainingWidth = hasMassSelect
    ? `calc((100% - 60px) / ${totalVisibleColumns})`
    : `${100 / totalVisibleColumns}%`
  return remainingWidth
}

const isReloading = computed(() => props.isLoading || pendingReset.value)
const isAdding = computed(() => props.isLoading || pendingAdd.value)
const paginationClass = computed(() => props.mobileFixedPagination
  ? 'fixed bottom-0 left-0 z-40 flex items-center justify-between w-full p-4 bg-white md:relative md:pt-4 md:bg-transparent dark:bg-gray-900 dark:md:bg-transparent'
  : 'flex items-center justify-between w-full p-4 bg-white md:relative md:pt-4 md:bg-transparent dark:bg-gray-900 dark:md:bg-transparent')
</script>

<template>
  <div class="pb-4 overflow-x-auto md:pb-0">
    <div class="flex flex-wrap items-center justify-between gap-2 p-3 pb-4 overflow-visible md:flex-nowrap">
      <div class="flex h-10 shrink-0 items-center">
        <button
          class="inline-flex items-center py-1.5 px-3 mr-2 text-sm font-medium text-gray-500 bg-white rounded-md border border-gray-300 cursor-pointer dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden"
          type="button" @click="handleResetClick"
        >
          <IconReload v-if="!isReloading" class="m-1 md:mr-2" />
          <Spinner v-else size="w-[16.8px] h-[16.8px] m-1 mr-2" />
          <span class="hidden text-sm md:block">{{ t("reload") }}</span>
        </button>
        <div
          v-if="exportable"
          class="d-dropdown"
          @focusout="onExportFocusOut"
          @keydown.escape.prevent="closeExportMenu"
        >
          <button
            ref="exportTriggerRef"
            type="button"
            class="d-btn d-btn-sm inline-flex h-full items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-500 shadow-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            :disabled="isLoading || exportLoading"
            data-test="data-table-export"
            :aria-label="t('export')"
            aria-haspopup="true"
            :aria-expanded="exportMenuOpen"
            :aria-controls="exportMenuId"
            @click="toggleExportMenu"
          >
            <IconDownload v-if="!exportLoading" class="m-1 md:mr-2" />
            <Spinner v-else size="w-[16.8px] h-[16.8px] m-1 mr-2" />
            <span class="hidden text-sm md:block">{{ t('export') }}</span>
          </button>
          <ul
            v-show="exportMenuOpen"
            :id="exportMenuId"
            class="d-dropdown-content d-menu z-20 mt-1 mr-2 w-40 rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            <li>
              <button
                type="button"
                class="d-btn d-btn-ghost d-btn-sm w-full justify-start rounded-md px-3 py-2 text-left text-sm font-normal text-slate-700 shadow-none dark:text-slate-200"
                data-test="data-table-export-csv"
                :disabled="isLoading || exportLoading"
                @click="exportTable('csv')"
              >
                {{ t('download-csv') }}
              </button>
            </li>
            <li>
              <button
                type="button"
                class="d-btn d-btn-ghost d-btn-sm w-full justify-start rounded-md px-3 py-2 text-left text-sm font-normal text-slate-700 shadow-none dark:text-slate-200"
                data-test="data-table-export-json"
                :disabled="isLoading || exportLoading"
                @click="exportTable('json')"
              >
                {{ t('download-json') }}
              </button>
            </li>
          </ul>
        </div>
        <div v-if="showAdd" class="p-px mr-2 rounded-lg from-cyan-500 to-purple-500 bg-linear-to-r">
          <button
            :data-test="addButtonTestId"
            :aria-describedby="addDisabled && addTooltip ? addTooltipId : undefined"
            :aria-disabled="addDisabled"
            :title="addDisabled ? addTooltip : undefined"
            class="inline-flex items-center py-1.5 px-3 text-sm font-medium text-gray-500 bg-white rounded-md cursor-pointer dark:text-white dark:bg-gray-800 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden aria-disabled:cursor-not-allowed aria-disabled:bg-gray-100 aria-disabled:text-gray-400 aria-disabled:hover:bg-gray-100 dark:aria-disabled:bg-gray-700 dark:aria-disabled:text-gray-500 dark:aria-disabled:hover:bg-gray-700"
            type="button" @click="handleAddClick"
          >
            <plusOutline v-if="!isAdding" class="m-1 md:mr-2" />
            <Spinner v-else size="w-[16.8px] h-[16.8px] m-1 mr-2" />
            <span class="hidden text-sm md:block">{{ t("add-one") }}</span>
          </button>
          <span v-if="addDisabled && addTooltip" :id="addTooltipId" class="sr-only">{{ addTooltip }}</span>
        </div>
        <div v-if="showFilterMenu" class="relative h-10">
          <button
            ref="filterOpenButtonRef"
            type="button"
            class="inline-flex items-center py-1.5 px-3 mr-2 h-full text-sm font-medium text-gray-500 bg-white rounded-md border border-gray-300 cursor-pointer dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden"
            data-test="data-table-filters-open"
            :aria-expanded="isFilterModalOpen"
            aria-haspopup="dialog"
            @click="openFilterModal"
          >
            <div
              v-if="filterActivated"
              class="absolute inline-flex items-center justify-center w-6 h-6 text-xs font-bold text-white bg-red-500 border-2 border-white rounded-full -top-2 -right-2 dark:border-gray-900"
            >
              {{ filterActivated }}
            </div>
            <IconFilter class="w-4 h-4 mr-2" />
            <span class="hidden md:block">{{ t(filterText ?? '') }}</span>
          </button>
          <FilterModal
            :open="isFilterModalOpen"
            :title="t(filterText ?? 'Filters')"
            :subtitle="t('filter-modal-subtitle')"
            :title-id="filterModalTitleId"
            :clear-disabled="!filterActivated"
            :restore-focus-el="filterOpenButtonRef"
            test-id-prefix="data-table"
            @close="closeFilterModal"
            @clear="clearAllFilters"
          >
            <div v-if="$slots['filter-extras']" class="space-y-4">
              <slot name="filter-extras" />
            </div>
            <div
              v-if="$slots['filter-extras'] && filterList.length"
              class="border-t border-slate-200 dark:border-slate-700"
              role="separator"
            />
            <fieldset v-if="filterList.length" class="space-y-1">
              <legend class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {{ t('filter-options') }}
              </legend>
              <label
                v-for="(f, i) in filterList"
                :key="f"
                :for="`filter-radio-example-${i}`"
                class="flex min-h-11 cursor-pointer items-center rounded-md px-2 py-2 transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <input
                  :id="`filter-radio-example-${i}`"
                  :checked="filters?.[f]"
                  type="checkbox"
                  :name="`filter-radio-${i}`"
                  class="h-4 w-4 shrink-0 rounded border-gray-300 text-azure-500 focus:ring-2 focus:ring-azure-500 dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800"
                  @change="
                    emit('update:filters', { ...filters, [f]: !filters?.[f] })
                  "
                >
                <span class="ml-3 min-w-0 text-sm font-medium text-slate-900 dark:text-slate-200">
                  {{ getFilterLabel(f) }}
                </span>
              </label>
            </fieldset>
          </FilterModal>
        </div>
      </div>
      <button
        v-if="isSelectAllEnabled"
        class="inline-flex items-center self-end px-3 py-2 ml-auto mr-2 text-sm font-medium text-gray-500 bg-white border border-gray-300 rounded-lg cursor-pointer dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden"
        type="button" @click="
          selectedRows = selectedRows.map(() => true);
          emit('selectRow', selectedRows);
        "
      >
        <span class="text-sm">{{ t("select_all") }}</span>
      </button>
      <button
        v-if="isSelectAllEnabled"
        class="inline-flex items-center self-end py-1.5 px-3 mr-2 text-sm font-medium text-gray-500 bg-white rounded-lg border border-gray-300 cursor-pointer dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700 focus:outline-hidden"
        type="button" @click="emit('massDelete')"
      >
        <IconTrash class="h-6 text-red-500" />
      </button>
      <div class="flex w-full min-w-0 flex-col items-stretch gap-2 overflow-visible sm:w-auto sm:min-w-0 sm:flex-1 sm:flex-row sm:items-center sm:justify-end md:w-auto md:flex-none">
        <div v-if="$slots['toolbar-extras']" class="flex h-10 shrink-0 items-center self-end sm:self-auto">
          <slot name="toolbar-extras" />
        </div>
        <div class="min-w-0 w-full overflow-hidden sm:w-auto sm:max-w-[13rem] md:max-w-[14rem] lg:max-w-[16rem] xl:max-w-xs">
          <FormKit
            v-model="searchVal" :placeholder="searchPlaceholder" :prefix-icon="IconSearch"
            :disabled="isLoading" enterkeyhint="send" :classes="{
              outer: 'mb-0! w-full sm:w-52 md:w-56 lg:w-64 xl:w-80',
            }"
          />
        </div>
      </div>
    </div>
    <slot name="table-notice" />
    <div class="block">
      <table id="custom_table" class="w-full text-sm text-left text-gray-500 pb-14 md:pb-0 dark:text-gray-400">
        <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:text-gray-400 dark:bg-gray-700">
          <tr>
            <th v-if="props.massSelect" class="px-4 md:px-6" />
            <th
              v-for="(col, i) in columns" :key="i" scope="col" class="px-4 py-1 md:py-3 md:px-6" :class="{
                'cursor-pointer': col.sortable,
                'hidden md:table-cell': !col.mobile,
              }" @click="sortClick(i)"
            >
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
        <tbody v-if="shouldShowRows">
          <tr
            v-for="(elem, i) in elementList" :key="i"
            class="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
          >
            <template v-if="true">
              <th v-if="props.massSelect" class="px-4 md:px-6">
                <input
                  :id="`select-row-${i}`"
                  :checked="selectedRows[i]"
                  class="scale-checkbox"
                  type="checkbox"
                  :aria-label="t('select_all')"
                  @click="(e: MouseEvent) => { handleCheckboxClick(i, e) }"
                >
              </th>
              <template v-for="(col, _y) in columns" :key="`${i}_${_y}`">
                <th
                  v-if="col.head" :class="`${col.class ?? ''}${!col.mobile ? ' hidden md:table-cell' : ''
                  } ${col.onClick
                    ? 'cursor-pointer hover:underline clickable-cell'
                    : ''
                  }`" scope="row" class="px-4 py-2 font-medium text-gray-900 whitespace-nowrap md:py-4 md:px-6 dark:text-white"
                  @click.stop="col.onClick ? col.onClick(elem) : () => { }"
                >
                  <RenderCell v-if="col.renderFunction" :renderer="col.renderFunction" :item="elem" />
                  <template v-else>
                    {{ displayValueKey(elem, col) }}
                  </template>
                </th>
                <td
                  v-else-if="col.actions || col.icon" :class="`${col.class ?? ''} ${!col.mobile ? 'hidden md:table-cell' : ''
                  }`" class="px-4 py-2 md:py-4 md:px-6"
                >
                  <div class="flex items-center space-x-1">
                    <template v-if="col.actions">
                      <div
                        v-for="(action, actionIndex) in col.actions"
                        v-show="!action.visible || action.visible(elem)" :key="actionIndex"
                      >
                        <div
                          class="relative inline-flex group"
                        >
                          <button
                            type="button"
                            :disabled="isActionDisabled(action, elem)"
                            :aria-describedby="getActionTitle(action, elem) ? tooltipIdFor(i, actionIndex) : undefined"
                            :data-test="action.testId ? (typeof action.testId === 'function' ? action.testId(elem) : action.testId) : undefined"
                            class="p-2 text-gray-500 rounded-md cursor-pointer dark:text-gray-400 hover:text-gray-600 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed dark:hover:bg-gray-700 dark:hover:text-gray-300 dark:disabled:hover:text-gray-400 disabled:hover:bg-transparent disabled:hover:text-gray-500"
                            @click.stop="action.onClick(elem)"
                          >
                            <component :is="action.icon" />
                          </button>
                          <span
                            v-if="getActionTitle(action, elem)"
                            :id="tooltipIdFor(i, actionIndex)"
                            role="tooltip"
                            class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg transition-opacity duration-150 group-hover:block group-focus-within:block dark:bg-slate-100 dark:text-slate-900"
                          >
                            {{ getActionTitle(action, elem) }}
                          </span>
                        </div>
                      </div>
                    </template>
                    <template v-else-if="col.icon">
                      <button
                        type="button"
                        class="p-2 text-gray-500 rounded-md cursor-pointer dark:text-gray-400 hover:text-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                        @click.stop="col.onClick ? col.onClick(elem) : () => { }"
                      >
                        <component :is="col.icon" />
                      </button>
                    </template>
                  </div>
                </td>
                <td
                  v-else
                  class="overflow-hidden text-ellipsis whitespace-nowrap px-4 py-2 md:py-4 md:px-6"
                  :class="`${col.class ?? ''} ${!col.mobile ? 'hidden md:table-cell' : ''
                  } ${col.onClick
                    ? 'cursor-pointer hover:underline clickable-cell'
                    : ''
                  }`"
                  @click.stop="col.onClick ? col.onClick(elem) : () => { }"
                >
                  <RenderCell v-if="col.renderFunction" :renderer="col.renderFunction" :item="elem" />
                  <template v-else>
                    {{ displayValueKey(elem, col) }}
                  </template>
                </td>
              </template>
            </template>
          </tr>
        </tbody>
        <tbody v-else-if="shouldShowEmptyState">
          <tr>
            <td
              :colspan="columns.length + (props.massSelect ? 1 : 0)"
              class="px-4 py-2 text-center text-gray-500 md:py-4 md:px-6 dark:text-gray-400"
            >
              <slot
                name="empty-state"
                :clear-filters="clearViewFilters"
                :has-active-filters="hasActiveViewFilters"
              >
                {{ t("no_elements_found") }}
              </slot>
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="i in 10" :key="i" :class="{ 'animate-pulse duration-1000': shouldShowSkeleton }">
            <td
              v-if="props.massSelect" class="px-4 py-2 md:py-4 md:px-6"
              :style="`width: ${getSkeletonWidth()}`"
            >
              <div class="mb-4 w-full h-2.5 bg-gray-200 rounded-full dark:bg-gray-700" />
            </td>
            <td
              v-for="(col, y) in columns" :key="`${i}_${y}`" class="px-4 py-2 md:py-4 md:px-6"
              :class="{ 'hidden md:table-cell': !col.mobile }" :style="`width: ${getSkeletonWidth(y)}`"
            >
              <div
                class="w-full bg-gray-200 rounded-full dark:bg-gray-700"
                :class="{ 'mb-4 h-2.5': col.head, 'h-2 mb-2.5': !col.head }"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <nav :class="paginationClass" aria-label="Table navigation">
      <span class="text-sm font-normal text-gray-500 dark:text-gray-400">
        <span class="hidden mr-1 md:inline-block">
          {{ t("showing") }}
        </span>
        <span class="font-semibold text-gray-900 dark:text-white">
          {{ displayElemRange }}
        </span>
        {{ t('of') }}
        <span class="font-semibold text-gray-900 dark:text-white">
          {{ total }}
        </span>
      </span>
      <ul class="inline-flex items-center -space-x-px">
        <li>
          <button
            type="button"
            class="block px-3 py-2 ml-0 leading-tight text-gray-500 bg-white border border-gray-300 rounded-l-lg cursor-pointer dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700"
            :class="{
              'hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-white':
                canPrev(),
            }" :disabled="!canPrev()" @click="fastBackward"
          >
            <span class="sr-only">{{ t("fast-backward") }}</span>
            <IconFastBackward />
          </button>
        </li>
        <li>
          <button
            type="button"
            class="block px-3 py-2 ml-0 leading-tight text-gray-500 bg-white border border-gray-300 cursor-pointer dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700"
            :class="{
              'hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-white':
                canPrev(),
            }" :disabled="!canPrev()" @click="prev"
          >
            <span class="sr-only">{{ t("previous") }}</span>
            <IconPrev />
          </button>
        </li>
        <li>
          <button
            type="button"
            aria-current="page"
            class="z-10 px-3 py-2 leading-tight text-blue-600 border border-blue-300 bg-blue-50 dark:text-white dark:bg-gray-700 dark:border-gray-700"
            disabled
          >
            {{ currentPage }}
          </button>
        </li>
        <li>
          <button
            type="button"
            class="block px-3 py-2 leading-tight text-gray-500 bg-white border border-gray-300 cursor-pointer dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700"
            :class="{
              'hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-white':
                canNext(),
            }" :disabled="!canNext()" @click="next"
          >
            <span class="sr-only">{{ t("next") }}</span>
            <IconNext />
          </button>
        </li>
        <li>
          <button
            type="button"
            class="block px-3 py-2 leading-tight text-gray-500 bg-white border border-gray-300 rounded-r-lg cursor-pointer dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700"
            :class="{
              'hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-white':
                canNext(),
            }" :disabled="!canNext()" @click="fastForward"
          >
            <span class="sr-only"> {{ t("fast-forward") }} </span>
            <IconFastForward />
          </button>
        </li>
      </ul>
    </nav>
  </div>
</template>

<style scoped>
.scale-checkbox {
  transform: scale(1.5);
  transform-origin: center;
}
</style>
