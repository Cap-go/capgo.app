<script setup lang="ts">
import { computed, useAttrs, useId } from 'vue'

/** Native checkbox with label and help text, styled like the former FormKit checkbox. */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  label?: string
  help?: string
  id?: string
  disabled?: boolean
  outerClass?: string
}>()

const model = defineModel<boolean>({ default: false })
const attrs = useAttrs()
const generatedId = useId()
const inputId = computed(() => props.id ?? generatedId)
const helpId = computed(() => `${inputId.value}-help`)
</script>

<template>
  <div class="group min-w-0 grow mb-4 text-base" :class="[outerClass, disabled ? 'select-none opacity-50' : '']" :data-disabled="disabled || undefined">
    <label :for="inputId" class="inline-flex items-center mb-1 cursor-pointer" :class="disabled ? 'cursor-not-allowed' : ''">
      <input
        v-bind="attrs"
        :id="inputId"
        v-model="model"
        type="checkbox"
        :disabled="disabled"
        :aria-describedby="help ? helpId : undefined"
        class="mr-1.5 w-4 h-4 rounded-sm border border-slate-400 accent-blue-600 shadow cursor-pointer disabled:cursor-not-allowed dark:border-slate-500"
      >
      <span class="text-sm text-neutral-700 dark:text-neutral-300">
        <slot name="label">{{ label }}</slot>
      </span>
    </label>
    <p v-if="help" :id="helpId" class="mb-1 text-xs text-neutral-700 dark:text-neutral-400">
      {{ help }}
    </p>
  </div>
</template>
