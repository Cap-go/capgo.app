<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  chooseLabel: string
  emptyLabel: string
  label: string
}>()

const emit = defineEmits<{
  pickerClosedWithoutSelection: []
  pickerOpenFailed: []
  pickerOpened: []
}>()

const modelValue = defineModel<unknown>()
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFileName = ref('')

function openFilePicker() {
  try {
    if (!fileInput.value)
      throw new Error('File input is unavailable')
    fileInput.value.value = ''
    fileInput.value.click()
    emit('pickerOpened')
  }
  catch {
    emit('pickerOpenFailed')
  }
}

function onFileSelected(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  if (!file) {
    emit('pickerClosedWithoutSelection')
    return
  }

  selectedFileName.value = file.name
  modelValue.value = file
}
</script>

<template>
  <div>
    <label for="app-onboarding-icon-input" class="text-sm font-medium text-slate-800 dark:text-slate-200">
      {{ label }}
    </label>
    <div class="mt-2 flex min-h-11 items-center gap-3">
      <button
        type="button"
        class="d-btn min-h-10 border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:border-white/15 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        @click="openFilePicker"
      >
        {{ chooseLabel }}
      </button>
      <span aria-live="polite" class="min-w-0 truncate text-sm text-slate-600 dark:text-slate-300">
        {{ selectedFileName || emptyLabel }}
      </span>
    </div>
    <input
      id="app-onboarding-icon-input"
      ref="fileInput"
      type="file"
      accept="image/*"
      hidden
      @cancel="emit('pickerClosedWithoutSelection')"
      @change="onFileSelected"
    >
  </div>
</template>
