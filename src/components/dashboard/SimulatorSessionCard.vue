<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconSmartphone from '~icons/lucide/smartphone'
import { defaultApiHost, useConsole } from '../../services/console'

const props = defineProps<{ appId: string }>()
const { t } = useI18n()
const capgo = useConsole()
const pending = ref<'ios' | 'android' | 'stop' | ''>('')
const sessionId = ref('')
const url = ref('')
const error = ref('')

async function sessionToken() {
  const { data } = await capgo.auth.getSession()
  const token = data.session?.access_token
  if (!token)
    throw new Error(t('simulator-sign-in'))
  return token
}

async function start(platform: 'ios' | 'android') {
  error.value = ''
  url.value = ''
  sessionId.value = ''
  pending.value = platform
  try {
    const response = await fetch(`${defaultApiHost}/private/simulator/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${await sessionToken()}`,
      },
      body: JSON.stringify({ app_id: props.appId, platform }),
    })
    const payload = await response.json().catch(() => undefined) as { data?: { id?: string, url?: string }, message?: string, error?: string } | undefined
    if (!response.ok)
      throw new Error(payload?.message || payload?.error || t('simulator-did-not-start'))
    sessionId.value = payload?.data?.id || ''
    url.value = payload?.data?.url || ''
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('simulator-did-not-start')
  }
  finally {
    pending.value = ''
  }
}

async function stop() {
  if (!sessionId.value)
    return
  error.value = ''
  pending.value = 'stop'
  try {
    const response = await fetch(`${defaultApiHost}/private/simulator/${sessionId.value}/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${await sessionToken()}`,
      },
      body: JSON.stringify({ app_id: props.appId }),
    })
    const payload = await response.json().catch(() => undefined) as { message?: string, error?: string } | undefined
    if (!response.ok)
      throw new Error(payload?.message || payload?.error || t('simulator-did-not-stop'))
    sessionId.value = ''
    url.value = ''
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('simulator-did-not-stop')
  }
  finally {
    pending.value = ''
  }
}
</script>

<template>
  <section class="p-4 mb-6 bg-white rounded-xl border border-slate-200 dark:bg-slate-900 dark:border-slate-700">
    <div class="flex flex-wrap gap-3 items-center">
      <span class="inline-flex gap-1 items-center px-2 py-1 text-xs font-medium text-white bg-slate-900 rounded-full dark:bg-white dark:text-slate-900">
        <IconSmartphone class="w-3.5 h-3.5" />
        {{ t('simulator') }}
      </span>
      <p class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('simulator-slot-minutes') }}
      </p>
    </div>
    <div class="flex flex-wrap gap-2 mt-4">
      <button type="button" class="text-white d-btn d-btn-primary" :disabled="pending !== ''" @click="start('ios')">
        {{ pending === 'ios' ? t('simulator-starting') : t('start-ios-simulator') }}
      </button>
      <button type="button" class="d-btn" :disabled="pending !== ''" @click="start('android')">
        {{ pending === 'android' ? t('simulator-starting') : t('start-android-simulator') }}
      </button>
      <button v-if="sessionId" type="button" class="d-btn" :disabled="pending !== ''" @click="stop()">
        {{ pending === 'stop' ? t('simulator-stopping') : t('stop-simulator') }}
      </button>
    </div>
    <a v-if="url" class="inline-block mt-3 text-sm text-blue-600 underline dark:text-blue-400" :href="url" target="_blank" rel="noreferrer">
      {{ url }}
    </a>
    <p v-if="error" class="mt-3 text-sm text-red-600 dark:text-red-400">
      {{ error }}
    </p>
  </section>
</template>
