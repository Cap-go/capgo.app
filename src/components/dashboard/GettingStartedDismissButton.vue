<script setup lang="ts">
import IconX from '~icons/lucide/x'

defineProps<{
  label: string
  testId: string
  disabled?: boolean
}>()
defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <button
    type="button"
    class="flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors duration-150 hover:bg-slate-700/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500 disabled:opacity-50"
    :aria-label="label"
    :disabled="disabled"
    :data-test="testId"
    @click="$emit('click', $event)"
  >
    <IconX class="size-4" aria-hidden="true" />
  </button>
</template>
