<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export type VersionGroupOption = 'version' | 'version_platform' | 'version_platform_channel'

const props = defineProps<{
  modelValue: VersionGroupOption
}>()

const emit = defineEmits<{
  'update:modelValue': [value: VersionGroupOption]
}>()

const { t } = useI18n()
const options: VersionGroupOption[] = ['version', 'version_platform', 'version_platform_channel']
const labels: Record<VersionGroupOption, string> = {
  version: 'native-observe-group-version',
  version_platform: 'native-observe-group-version-platform',
  version_platform_channel: 'native-observe-group-version-platform-channel',
}

const selectedLabel = computed(() => labels[props.modelValue])

function select(option: VersionGroupOption) {
  if (option !== props.modelValue)
    emit('update:modelValue', option)
}
</script>

<template>
  <fieldset
    class="flex flex-wrap items-center p-1 space-x-1 shrink-0 bg-gray-200 rounded-lg dark:bg-gray-800"
    data-testid="version-group-selector"
  >
    <legend class="sr-only">
      {{ t('native-observe-version-group') }}: {{ t(selectedLabel) }}
    </legend>
    <button
      v-for="option in options"
      :key="option"
      type="button"
      :aria-pressed="props.modelValue === option"
      :aria-label="t(labels[option])"
      class="flex justify-center items-center h-9 min-h-9 min-w-[2.75rem] px-2.5 sm:px-3 py-1.5 text-xs font-medium text-center whitespace-nowrap rounded-md transition-colors duration-150 cursor-pointer"
      :class="props.modelValue === option
        ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'"
      @click="select(option)"
    >
      {{ t(labels[option]) }}
    </button>
  </fieldset>
</template>
