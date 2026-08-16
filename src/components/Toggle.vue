<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  value: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:value', 'change'])
const { t } = useI18n()
const inputId = useId()

function onChange(event: Event) {
  const target = event.target as HTMLInputElement | null
  const nextValue = target ? target.checked : !props.value
  emit('update:value', nextValue)
  emit('change', nextValue)
}
</script>

<template>
  <label class="inline-flex relative items-center cursor-pointer" :for="inputId">
    <span class="sr-only">{{ ariaLabel || t('toggle') }}</span>
    <input :id="inputId" type="checkbox" class="sr-only peer" :checked="value" :disabled="disabled" @change="onChange">
    <div class="w-11 h-6 bg-gray-200 rounded-full dark:bg-gray-700 dark:border-gray-600 peer after:absolute after:left-[2px] after:top-0.5 after:h-5 after:w-5 after:border after:border-gray-300 after:rounded-full after:bg-white peer-checked:bg-blue-600 after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white" />
  </label>
</template>
