<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps<{
  label: string
  value?: string
  editable?: boolean
  isLink?: boolean
  labelClass?: string
  readonly?: boolean
  placeholder?: string
  /** Force the stacked phone layout; use when a long value comes through the default slot. */
  stacked?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:value', value: string | undefined): void
  (event: 'delete', key: string): void
}>()

const computedValue = reactive({ value: props.value })
// Sentence-like values (descriptions) read badly right-aligned next to the label on
// phones: drop them under the label, left-aligned, with any control kept at the end.
const isLongText = computed(() => !!props.stacked || (!props.editable && (props.value?.length ?? 0) > 40))
const rowInput = ref(props.value ?? '')
// Keep the input in sync with the stored value (after a save or a reload).
watch(() => props.value, (value) => {
  rowInput.value = value ?? ''
})

// Put the input back to the stored value, for a parent that rejects the commit.
function reset() {
  rowInput.value = props.value ?? ''
}

// Commit only on blur (Enter blurs), and only when the value changed: focusing then
// leaving the field must never write anything.
function commit() {
  if (props.readonly || rowInput.value === (props.value ?? ''))
    return
  emit('update:value', rowInput.value)
}

defineExpose({ reset })
</script>

<template>
  <!-- Phones: label and value share one row (value right-aligned) like a native settings list; long values wrap. -->
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 px-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:py-5 sm:px-6">
    <dl>
      <dt class="text-sm font-medium text-gray-700 dark:text-gray-200 first-letter:uppercase" :class="props.labelClass">
        {{ props.label }}
      </dt>
    </dl>
    <dd
      class="min-w-0 text-sm break-words sm:col-span-2 sm:text-left"
      :class="{
        'basis-full text-left': isLongText,
        'flex-[1_1_12rem] text-right': !isLongText,
        'cursor-pointer underline underline-offset-4 text-blue-600 active dark:text-blue-500 font-bold': props.isLink,
        'text-gray-600 dark:text-gray-200': !props.isLink,
      }"
    >
      <div class="flex flex-row items-center gap-x-2 sm:flex-nowrap sm:justify-start sm:gap-x-0" :class="isLongText ? 'justify-between flex-nowrap' : 'justify-end flex-wrap'">
        <input
          v-if="editable"
          id="inforow-input"
          v-model="rowInput"
          type="text"
          :aria-label="props.label"
          :placeholder="props.placeholder"
          class="block py-1.5 px-2.5 w-full text-sm text-gray-900 bg-white rounded-md border border-gray-300 shadow-sm transition-colors md:w-1/2 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-white dark:bg-gray-800 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:focus:border-blue-400 dark:focus:ring-blue-400/30 read-only:cursor-not-allowed read-only:bg-gray-50 dark:read-only:bg-gray-900"
          :readonly="!!props.readonly"
          @blur="commit"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        >
        <span v-else> {{ computedValue.value }} </span>
        <div style="margin-left: 0">
          <slot name="start" />
        </div>
        <div style="margin-left: auto" class="min-w-0 sm:max-w-1/2">
          <slot />
        </div>
      </div>
    </dd>
  </div>
</template>
