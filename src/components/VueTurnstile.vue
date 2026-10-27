<script setup lang="ts">
/**
 * Cloudflare Turnstile widget. Same props, events and exposed methods as the `vue-turnstile`
 * package, written with the Composition API so the app can ship without Vue's Options API.
 */
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'

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
  appearance: 'always',
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
  if (!api)
    return
  emit('update:modelValue', '')
  api.reset()
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

<script lang="ts">
interface TurnstileRenderOptions {
  'sitekey': string
  'theme': string
  'language': string
  'size': string
  'action': string
  'appearance': string
  'callback': (token: string) => void
  'error-callback': (error: unknown) => void
  'expired-callback': () => void
  'unsupported-callback': () => void
  'before-interactive-callback': () => void
  'after-interactive-callback': () => void
}

interface TurnstileApi {
  render: (element: HTMLElement, options: TurnstileRenderOptions) => string
  reset: (widgetId?: string) => void
  remove: (widgetId: string) => void
}

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
const ONLOAD_CALLBACK_NAME = 'cfTurnstileOnLoad'

function turnstileApi() {
  return typeof window === 'undefined' ? undefined : (window as unknown as { turnstile?: TurnstileApi }).turnstile
}

// Shared across every widget instance: the Cloudflare script is injected once.
let scriptState: 'unloaded' | 'loading' | 'ready' = turnstileApi() ? 'ready' : 'unloaded'
let scriptLoad: Promise<void> | undefined

function loadTurnstileScript(): Promise<void> {
  if (scriptState === 'ready')
    return Promise.resolve()
  if (scriptLoad)
    return scriptLoad

  scriptLoad = new Promise<void>((resolve, reject) => {
    (window as unknown as Record<string, () => void>)[ONLOAD_CALLBACK_NAME] = () => {
      scriptState = 'ready'
      resolve()
    }
    scriptState = 'loading'
    const script = document.createElement('script')
    script.src = `${TURNSTILE_SCRIPT_URL}?onload=${ONLOAD_CALLBACK_NAME}&render=explicit`
    script.async = true
    script.addEventListener('error', () => {
      scriptLoad = undefined
      scriptState = 'unloaded'
      reject(new Error('Failed to load Turnstile.'))
    })
    document.head.appendChild(script)
  })
  return scriptLoad
}
</script>

<template>
  <div ref="turnstile" />
</template>
