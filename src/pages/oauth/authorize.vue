<script setup lang="ts">
import type { CliLoginOrganization, CliSkippedOrganization } from '~/services/cliLogin'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconExclamationTriangle from '~icons/heroicons/exclamation-triangle'
import IconSparkles from '~icons/heroicons/sparkles'
import CliLoginSkippedOrganizations from '~/components/CliLoginSkippedOrganizations.vue'
import { getCapgoApiErrorCode, invokeCapgoApi } from '~/services/capgoApi'
import { createCliLoginKeyDependencies, createMcpOAuthKey, mcpOAuthKeyName, resolveCliKeyEligibility } from '~/services/cliLogin'
import { useConsole } from '~/services/console'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

type PageState = 'loading' | 'ready' | 'empty' | 'submitting' | 'redirecting' | 'denied' | 'expired' | 'error'

interface AuthorizationRequest {
  request: string
  client_id: string
  client_name: string
  redirect_host: string
  expires_at: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const { t } = useI18n()
const route = useRoute()
const supabase = useConsole()
const main = useMainStore()
const organizationStore = useOrganizationStore()

const state = ref<PageState>('loading')
const details = ref<AuthorizationRequest | null>(null)
const eligible = ref<CliLoginOrganization[]>([])
const skipped = ref<CliSkippedOrganization[]>([])
const selected = ref<string[]>([])
const showSelectionError = ref(false)

const requestId = computed(() => {
  const value = Array.isArray(route.query.request) ? route.query.request[0] : route.query.request
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
})
const clientName = computed(() => details.value?.client_name ?? '')
const keyName = computed(() => mcpOAuthKeyName(clientName.value))

function dependencies() {
  const userId = main.user?.id ?? main.auth?.id
  if (!userId)
    throw new Error('Missing authenticated user')
  return createCliLoginKeyDependencies(supabase, userId)
}

async function stateForError(error: unknown): Promise<PageState> {
  const code = await getCapgoApiErrorCode(error)
  return code === 'request_expired' || code === 'request_not_found' ? 'expired' : 'error'
}

async function load(): Promise<void> {
  if (!requestId.value) {
    state.value = 'expired'
    return
  }
  try {
    const { data, error } = await invokeCapgoApi<AuthorizationRequest>(`private/mcp_oauth?request=${encodeURIComponent(requestId.value)}`, {
      client: supabase,
      method: 'GET',
    })
    if (error || !data) {
      state.value = await stateForError(error)
      return
    }
    details.value = data
    await organizationStore.awaitInitialLoad()
    const eligibility = await resolveCliKeyEligibility(organizationStore.organizations, dependencies())
    eligible.value = eligibility.eligible
    skipped.value = eligibility.skippedOrganizations
    selected.value = eligibility.eligible.map(organization => organization.gid)
    state.value = eligibility.eligible.length ? 'ready' : 'empty'
  }
  catch (error) {
    console.error('Cannot load MCP authorization request', error)
    state.value = 'error'
  }
}

async function approve(): Promise<void> {
  if (!details.value || state.value !== 'ready')
    return
  const organizations = eligible.value.filter(organization => selected.value.includes(organization.gid))
  if (!organizations.length) {
    showSelectionError.value = true
    return
  }
  state.value = 'submitting'
  try {
    const apikey = await createMcpOAuthKey(organizations, dependencies(), details.value.client_name)
    const { data, error } = await invokeCapgoApi<{ redirect_to: string }>('private/mcp_oauth/approve', {
      client: supabase,
      method: 'POST',
      body: { request: details.value.request, apikey },
    })
    if (error || !data?.redirect_to) {
      state.value = await stateForError(error)
      return
    }
    state.value = 'redirecting'
    window.location.assign(data.redirect_to)
  }
  catch (error) {
    console.error('Cannot approve MCP authorization request', error)
    state.value = 'error'
  }
}

async function deny(): Promise<void> {
  if (!details.value)
    return
  state.value = 'submitting'
  const { data, error } = await invokeCapgoApi<{ redirect_to: string }>('private/mcp_oauth/deny', {
    client: supabase,
    method: 'POST',
    body: { request: details.value.request },
  })
  if (error || !data?.redirect_to) {
    state.value = 'denied'
    return
  }
  state.value = 'denied'
  window.location.assign(data.redirect_to)
}

onMounted(load)
</script>

<template>
  <main class="flex min-h-full items-center justify-center bg-slate-100 px-4 py-10 dark:bg-slate-900">
    <section class="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-8">
      <header class="mb-6 flex items-center gap-3">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100 text-primary dark:bg-orange-950/40">
          <IconSparkles class="h-5 w-5" />
        </span>
        <h1 class="text-2xl font-semibold text-slate-950 dark:text-white">
          {{ clientName ? t('mcp-oauth-title', { client: clientName }) : 'Capgo MCP' }}
        </h1>
      </header>

      <div v-if="state === 'loading'" role="status" class="flex items-center gap-3 text-slate-600 dark:text-slate-300">
        <span class="d-loading d-loading-spinner d-loading-md text-primary" aria-hidden="true" />
        <span>{{ t('mcp-oauth-loading') }}</span>
      </div>

      <p v-else-if="state === 'expired'" class="d-alert d-alert-warning">
        {{ t('mcp-oauth-expired') }}
      </p>

      <p v-else-if="state === 'error'" class="d-alert d-alert-error">
        {{ t('mcp-oauth-error') }}
      </p>

      <p v-else-if="state === 'denied'" class="text-slate-600 dark:text-slate-300">
        {{ t('mcp-oauth-denied') }}
      </p>

      <div v-else-if="state === 'redirecting'" role="status" class="flex items-center gap-3 text-slate-600 dark:text-slate-300">
        <IconCheckCircle class="h-5 w-5 text-emerald-500" aria-hidden="true" />
        <span>{{ t('mcp-oauth-connected', { client: clientName }) }}</span>
      </div>

      <div v-else-if="state === 'empty'" class="space-y-4">
        <p class="d-alert d-alert-warning">
          {{ t('mcp-oauth-no-eligible') }}
        </p>
        <CliLoginSkippedOrganizations v-if="skipped.length" :organizations="skipped" />
        <button class="d-btn" type="button" @click="deny">
          {{ t('mcp-oauth-deny') }}
        </button>
      </div>

      <form v-else class="space-y-5" @submit.prevent="approve">
        <p class="text-slate-600 dark:text-slate-300">
          {{ t('mcp-oauth-description', { client: clientName }) }}
        </p>

        <fieldset class="space-y-2">
          <legend class="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {{ t('mcp-oauth-organizations') }}
          </legend>
          <label
            v-for="organization in eligible"
            :key="organization.gid"
            class="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-700"
          >
            <input v-model="selected" type="checkbox" class="d-checkbox d-checkbox-primary" :value="organization.gid" @change="showSelectionError = false">
            <span class="font-medium text-slate-900 dark:text-slate-100">{{ organization.name }}</span>
          </label>
          <p v-if="showSelectionError" class="text-sm text-red-600" role="alert">
            {{ t('mcp-oauth-select-organization') }}
          </p>
        </fieldset>

        <CliLoginSkippedOrganizations v-if="skipped.length" :organizations="skipped" has-key />

        <div class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
          <p class="flex items-start gap-2">
            <IconExclamationTriangle class="mt-1 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
            <span>{{ t('mcp-oauth-unverified') }}</span>
          </p>
          <p>{{ t('mcp-oauth-redirect', { host: details?.redirect_host }) }}</p>
          <p>{{ t('mcp-oauth-key-note', { name: keyName }) }}</p>
        </div>

        <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button class="d-btn" type="button" :disabled="state === 'submitting'" @click="deny">
            {{ t('mcp-oauth-deny') }}
          </button>
          <button class="d-btn d-btn-primary" type="submit" :disabled="state === 'submitting'">
            <span v-if="state === 'submitting'" class="d-loading d-loading-spinner d-loading-sm" aria-hidden="true" />
            {{ t('mcp-oauth-allow') }}
          </button>
        </div>
      </form>
    </section>
  </main>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
