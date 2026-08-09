<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  options: string[]
  modelValue: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const { t } = useI18n()
const searchId = useId()
const listId = useId()
const bundleSearch = ref('')

const selectedSet = computed(() => new Set(props.modelValue))

const filteredOptions = computed(() => {
  const query = bundleSearch.value.trim().toLowerCase()
  if (!query)
    return props.options
  return props.options.filter(name => name.toLowerCase().includes(query))
})

const exactSearchMatch = computed(() => {
  const query = bundleSearch.value.trim()
  if (!query)
    return ''
  const existing = props.options.find(name => name.toLowerCase() === query.toLowerCase())
  return existing || query
})

const canAddCustomSearch = computed(() => {
  const query = bundleSearch.value.trim()
  if (!query)
    return false
  return !props.options.some(name => name.toLowerCase() === query.toLowerCase())
    && !selectedSet.value.has(query)
})

function toggleBundle(name: string) {
  const next = selectedSet.value.has(name)
    ? props.modelValue.filter(value => value !== name)
    : [...props.modelValue, name]
  emit('update:modelValue', next)
}

function addCustomSearch() {
  const query = bundleSearch.value.trim()
  if (!query || selectedSet.value.has(query))
    return
  emit('update:modelValue', [...props.modelValue, query])
  bundleSearch.value = ''
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  if (canAddCustomSearch.value) {
    addCustomSearch()
    return
  }
  const match = exactSearchMatch.value
  if (match && !selectedSet.value.has(match))
    toggleBundle(match)
}

function clearSelection() {
  if (!props.modelValue.length)
    return
  emit('update:modelValue', [])
}
</script>

<template>
  <div class="flex w-full flex-col gap-2" data-test="device-bundle-filter">
    <div class="flex items-center justify-between gap-2">
      <label
        :for="searchId"
        class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
      >
        {{ t('bundle') }}
      </label>
      <button
        v-if="modelValue.length"
        type="button"
        class="text-xs font-medium text-azure-600 hover:text-azure-700 focus:outline-hidden focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-400 dark:hover:text-azure-300"
        data-test="device-bundle-filter-clear"
        @click="clearSelection"
      >
        {{ t('clear-selection') }}
      </button>
    </div>

    <input
      :id="searchId"
      v-model="bundleSearch"
      type="search"
      class="d-input d-input-bordered min-h-11 w-full border-slate-200 bg-white text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
      :placeholder="t('search-versions')"
      :aria-label="t('search-versions')"
      :aria-controls="listId"
      data-test="device-bundle-filter-search"
      autocomplete="off"
      @keydown="onSearchKeydown"
    >

    <div
      v-if="modelValue.length"
      class="flex flex-wrap gap-1.5"
      data-test="device-bundle-filter-chips"
    >
      <span
        v-for="name in modelValue"
        :key="name"
        class="inline-flex max-w-full items-center gap-1 rounded-md border border-azure-200 bg-azure-50 px-2 py-1 text-xs font-medium text-azure-800 dark:border-azure-500/30 dark:bg-azure-400/10 dark:text-azure-200"
      >
        <span class="truncate">{{ name }}</span>
        <button
          type="button"
          class="shrink-0 rounded-sm text-azure-700 hover:text-azure-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-300 dark:hover:text-azure-100"
          :aria-label="t('remove-bundle-filter', { name })"
          :data-test="`device-bundle-filter-remove-${name}`"
          @click="toggleBundle(name)"
        >
          ×
        </button>
      </span>
    </div>

    <ul
      :id="listId"
      class="max-h-48 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700"
      role="listbox"
      :aria-label="t('bundle')"
      :aria-multiselectable="true"
      data-test="device-bundle-filter-list"
    >
      <li v-if="canAddCustomSearch">
        <button
          type="button"
          class="flex min-h-11 w-full items-center px-3 py-2 text-left text-sm font-medium text-azure-700 transition-colors duration-150 hover:bg-slate-50 dark:text-azure-300 dark:hover:bg-slate-800"
          data-test="device-bundle-filter-add-custom"
          @click="addCustomSearch"
        >
          {{ t('add-bundle-filter', { name: bundleSearch.trim() }) }}
        </button>
      </li>
      <li v-for="name in filteredOptions" :key="name">
        <label
          class="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-slate-800"
          :class="selectedSet.has(name) ? 'bg-azure-50/70 dark:bg-azure-400/5' : ''"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 rounded border-gray-300 text-azure-500 focus:ring-2 focus:ring-azure-500 dark:border-gray-600 dark:bg-gray-700"
            :checked="selectedSet.has(name)"
            :data-test="`device-bundle-filter-option-${name}`"
            @change="toggleBundle(name)"
          >
          <span class="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-slate-200">
            {{ name }}
          </span>
        </label>
      </li>
      <li
        v-if="!filteredOptions.length && !canAddCustomSearch"
        class="px-3 py-4 text-center text-sm text-slate-500 dark:text-slate-400"
        data-test="device-bundle-filter-empty"
      >
        {{ t('no-results') }}
      </li>
    </ul>
  </div>
</template>
