<script setup lang="ts">
import { FormKit } from '@formkit/vue'

defineProps<{
  label: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: unknown]
}>()

function updateModelValue(value: unknown) {
  emit('update:modelValue', value)
}
</script>

<template>
  <FormKit
    type="file"
    :label="label"
    accept="image/*"
    outer-class="mt-0"
    label-class="text-sm font-medium text-slate-800 dark:text-slate-200"
    input-class="mt-2 block w-full min-h-11 text-sm text-slate-600 file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:text-sm file:font-medium file:text-slate-700 dark:text-slate-300 dark:file:bg-slate-800 dark:file:text-slate-200"
    no-files-class="text-slate-600! dark:text-slate-300!"
    @update:model-value="updateModelValue"
  />
</template>
