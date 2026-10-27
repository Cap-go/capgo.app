<script setup lang="ts">
import type { Component } from 'vue'
import { computed, ref, useAttrs, useId } from 'vue'

/**
 * Native labelled input that replaces FormKit text, email, password, number and url fields.
 * Extra attributes (autocomplete, inputmode, data-test, min, ...) land on the <input>.
 */
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  label?: string
  type?: 'text' | 'email' | 'password' | 'number' | 'url' | 'search' | 'tel'
  id?: string
  placeholder?: string
  help?: string
  prefixIcon?: Component
  disabled?: boolean
  /** Validation errors for this field; shown according to `validationVisibility`. */
  errors?: string[] | string | null
  /** blur: after the field lost focus once, dirty: after the first edit, live: always, submit: only after `submitted`. */
  validationVisibility?: 'blur' | 'dirty' | 'live' | 'submit'
  /** Set by the form after a submit attempt so every error shows. */
  submitted?: boolean
  outerClass?: string
  innerClass?: string
  inputClass?: string
  labelClass?: string
  messageClass?: string
}>(), {
  type: 'text',
  validationVisibility: 'blur',
})

const emit = defineEmits<{ blur: [event: FocusEvent] }>()
const model = defineModel<string | number | null | undefined>()
const attrs = useAttrs()

const generatedId = useId()
const inputId = computed(() => props.id ?? generatedId)
const messagesId = computed(() => `${inputId.value}-messages`)
const blurred = ref(false)
const dirty = ref(false)

const errorList = computed(() => {
  if (!props.errors)
    return []
  return (Array.isArray(props.errors) ? props.errors : [props.errors]).filter(Boolean)
})

const showErrors = computed(() => {
  if (errorList.value.length === 0)
    return false
  if (props.submitted || props.validationVisibility === 'live')
    return true
  if (props.validationVisibility === 'blur')
    return blurred.value
  if (props.validationVisibility === 'dirty')
    return dirty.value
  return false
})

const inputValue = computed({
  get: () => model.value ?? '',
  set: (value: string | number) => {
    dirty.value = true
    // Vue's v-model already casts `type="number"` inputs to numbers.
    model.value = value
  },
})

function onBlur(event: FocusEvent) {
  blurred.value = true
  emit('blur', event)
}
</script>

<template>
  <div
    class="group min-w-0 grow mb-4 text-base"
    :class="[outerClass, disabled ? 'select-none opacity-50' : '']"
    :data-invalid="showErrors || undefined"
    :data-disabled="disabled || undefined"
  >
    <div class="flex flex-col items-start justify-start mb-1.5 last:mb-0">
      <label
        v-if="label"
        :for="inputId"
        class="inline-flex mb-1 text-sm font-bold text-neutral-700 dark:text-neutral-300"
        :class="labelClass"
      >{{ label }}</label>
      <div
        class="flex items-center w-full px-3 py-2 text-base border border-gray-300 rounded-lg shadow focus-within:ring-1 focus-within:ring-blue-500! focus-within:border-blue-500! dark:bg-transparent dark:border-gray-600"
        :class="[
          innerClass,
          showErrors ? 'border-red-500 ring-1 ring-red-500 dark:border-red-500 dark:ring-red-500' : '',
          disabled ? 'cursor-not-allowed bg-neutral-100 dark:bg-neutral-800/5' : '',
        ]"
      >
        <span v-if="prefixIcon" class="flex items-center -ml-1 mr-2 text-base h-[1em] w-[1em] shrink-0 [&>svg]:w-full text-neutral-600 dark:text-neutral-300">
          <component :is="prefixIcon" aria-hidden="true" />
        </span>
        <span v-if="$slots.prefix" class="mr-1 text-neutral-600 dark:text-neutral-300">
          <slot name="prefix" />
        </span>
        <input
          v-bind="attrs"
          :id="inputId"
          v-model="inputValue"
          :type="type"
          :placeholder="placeholder"
          :disabled="disabled"
          :aria-invalid="showErrors || undefined"
          :aria-describedby="showErrors || help ? messagesId : undefined"
          class="min-w-0 min-h-[1.5em] grow p-0 text-base bg-transparent border-none appearance-none outline-hidden text-neutral-700 placeholder:text-neutral-400 focus:ring-0 scheme-light dark:scheme-dark dark:text-neutral-300 dark:placeholder-neutral-400/50 selection:bg-blue-100 selection:text-neutral-700 disabled:cursor-not-allowed"
          :class="inputClass"
          @blur="onBlur"
        >
        <slot name="suffix" />
      </div>
    </div>
    <div v-if="help || showErrors" :id="messagesId">
      <p v-if="help" class="text-xs text-neutral-700 dark:text-neutral-400">
        {{ help }}
      </p>
      <ul v-if="showErrors" class="mb-1.5" data-message-type="validation">
        <li v-for="error in errorList" :key="error" class="text-xs text-red-600 dark:text-red-400" :class="messageClass">
          {{ error }}
        </li>
      </ul>
    </div>
  </div>
</template>
