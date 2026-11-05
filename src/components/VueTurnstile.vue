<script setup lang="ts">
/**
 * Cloudflare Turnstile widget. Same props, events and exposed methods as the `vue-turnstile`
 * package, written with the Composition API so the app can ship without Vue's Options API.
 */
import type { TurnstileRenderOptions } from '~/utils/turnstile'
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { loadTurnstileScript, turnstileApi } from '~/utils/turnstile'

const props = withDefaults(defineProps<{
  siteKey: string
  modelValue: string
  resetInterval?: number
  size?: string
  theme?: string
  language?: string
  action?: string
  appearance?: string
  renderOnMount?: boolean
}>(), {
  resetInterval: 295 * 1000,
  size: 'normal',
  theme: 'auto',
  language: 'auto',
  action: '',
  // Most visitors pass Turnstile without interacting, so only show the widget when Cloudflare needs a click.
  appearance: 'interaction-only',
  renderOnMount: true,
})

const emit = defineEmits<{
  'update:modelValue': [token: string]
  'error': [error: unknown]
  'unsupported': []
  'expired': []
  'beforeInteractive': []
  'afterInteractive': []
}>()

const container = useTemplateRef<HTMLDivElement>('turnstile')
let widgetId: string | undefined
let resetTimeout: ReturnType<typeof setTimeout> | undefined

const options = computed<TurnstileRenderOptions>(() => ({
  'sitekey': props.siteKey,
  'theme': props.theme,
  'language': props.language,
  'size': props.size,
  'action': props.action,
  'appearance': props.appearance,
  'callback': (token) => {
    emit('update:modelValue', token)
    startResetTimeout()
  },
  'error-callback': error => emit('error', error),
  'expired-callback': () => emit('expired'),
  'unsupported-callback': () => emit('unsupported'),
  'before-interactive-callback': () => emit('beforeInteractive'),
  'after-interactive-callback': () => emit('afterInteractive'),
}))

function reset() {
  const api = turnstileApi()
  if (!api || !widgetId)
    return
  emit('update:modelValue', '')
  // Target this instance's widget: a page can show several.
  api.reset(widgetId)
}

function remove() {
  if (!widgetId)
    return
  turnstileApi()?.remove(widgetId)
  widgetId = undefined
}

function render() {
  const api = turnstileApi()
  if (container.value && api)
    widgetId = api.render(container.value, options.value)
}

function startResetTimeout() {
  // A newer token restarts the countdown; the previous timer must not reset it early.
  clearTimeout(resetTimeout)
  resetTimeout = setTimeout(reset, props.resetInterval)
}

onMounted(async () => {
  try {
    await loadTurnstileScript()
  }
  catch (error) {
    emit('error', error)
    return
  }
  if (props.renderOnMount)
    render()
})

onBeforeUnmount(() => {
  remove()
  clearTimeout(resetTimeout)
})

defineExpose({ reset, remove, render })
</script>


<template>
  <div ref="turnstile" />
</template>
