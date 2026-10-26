<script setup lang="ts">
import type { CliLoginKeyDependencies, CliLoginOrganization, CliSkippedOrganization } from '~/services/cliLogin'
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

// auth.md agent registration (https://capgo.app/auth.md): the agent gave the user this link and a
// six-digit code. The user picks organizations and types the code; the agent then receives an API key.
type PageState = 'loading' | 'ready' | 'empty' | 'wrong-account' | 'submitting' | 'approved' | 'denied' | 'expired' | 'error'

interface ClaimDetails {
  registration_id: string
  login_hint: string
  email_matches: boolean
  expires_at: string
}

const AGENT_CLIENT_NAME = 'AI agent (auth.md)'

const { t } = useI18n()
const route = useRoute()
const capgo = useConsole()
const main = useMainStore()
const organizationStore = useOrganizationStore()

const state = ref<PageState>('loading')
const details = ref<ClaimDetails | null>(null)
const eligible = ref<CliLoginOrganization[]>([])
const skipped = ref<CliSkippedOrganization[]>([])
const selected = ref<string[]>([])
const userCode = ref('')
const showSelectionError = ref(false)
const codeError = ref('')

const attemptToken = computed(() => {
  const value = Array.isArray(route.query.claim_attempt_token) ? route.query.claim_attempt_token[0] : route.query.claim_attempt_token
  return typeof value === 'string' && /^[\w-]{20,200}$/.test(value) ? value : null
})
const keyName = mcpOAuthKeyName(AGENT_CLIENT_NAME)

function dependencies() {
  const userId = main.user?.id ?? main.auth?.id
  if (!userId)
    throw new Error('Missing authenticated user')
  return createCliLoginKeyDependencies(capgo, userId)
}

async function stateForError(error: unknown): Promise<PageState> {
  const code = await getCapgoApiErrorCode(error)
  if (code === 'request_expired')
    return 'expired'
  if (code === 'wrong_account')
    return 'wrong-account'
  return 'error'
}

async function load(): Promise<void> {
  if (!attemptToken.value) {
    state.value = 'expired'
    return
  }
  try {
    const { data, error } = await invokeCapgoApi<ClaimDetails>(`private/agent_identity/?claim_attempt_token=${encodeURIComponent(attemptToken.value)}`, {
      client: capgo,
      method: 'GET',
    })
    if (error || !data) {
      state.value = await stateForError(error)
      return
    }
    details.value = data
    if (!data.email_matches) {
      state.value = 'wrong-account'
      return
    }
    await organizationStore.awaitInitialLoad()
    const eligibility = await resolveCliKeyEligibility(organizationStore.organizations, dependencies())
    eligible.value = eligibility.eligible
    skipped.value = eligibility.skippedOrganizations
    selected.value = eligibility.eligible.map(organization => organization.gid)
    state.value = eligibility.eligible.length ? 'ready' : 'empty'
  }
  catch (error) {
    console.error('Cannot load agent claim request', error)
    state.value = 'error'
  }
}

// The key is minted before approval; if approval fails, delete it so no unused credential stays behind.
let createdKeyId: number | null = null

const createTrackedKey: CliLoginKeyDependencies['createKey'] = async (input) => {
  const { data, error } = await invokeCapgoApi<{ id?: number, key?: string | null }>('apikey', {
    client: capgo,
    method: 'POST',
    body: input,
  })
  if (error)
    throw error
  createdKeyId = typeof data?.id === 'number' ? data.id : null
  return { key: data?.key ?? null }
}

async function deleteUnusedKey(): Promise<void> {
  if (createdKeyId === null)
    return
  const id = createdKeyId
  createdKeyId = null
  const { error } = await invokeCapgoApi(`apikey/${id}`, { client: capgo, method: 'DELETE' })
  if (error)
    console.error('Cannot delete the unused agent API key', error)
}

async function approve(): Promise<void> {
  if (!attemptToken.value || state.value !== 'ready')
    return
  const organizations = eligible.value.filter(organization => selected.value.includes(organization.gid))
  if (!organizations.length) {
    showSelectionError.value = true
    return
  }
  const code = userCode.value.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) {
    codeError.value = t('agent-claim-code-format')
    return
  }
  state.value = 'submitting'
  try {
    // Check the code before minting a key, so a typo never leaves an unused API key behind.
    const verify = await invokeCapgoApi('private/agent_identity/verify', {
      client: capgo,
      method: 'POST',
      body: { claim_attempt_token: attemptToken.value, user_code: code },
    })
    if (verify.error) {
      if (await getCapgoApiErrorCode(verify.error) === 'invalid_user_code') {
        codeError.value = t('agent-claim-code-mismatch')
        state.value = 'ready'
        return
      }
      state.value = await stateForError(verify.error)
      return
    }
    const apikey = await createMcpOAuthKey(organizations, { createKey: createTrackedKey }, AGENT_CLIENT_NAME)
    const { error } = await invokeCapgoApi('private/agent_identity/approve', {
      client: capgo,
      method: 'POST',
      body: { claim_attempt_token: attemptToken.value, apikey },
    })
    if (error) {
      await deleteUnusedKey()
      state.value = await stateForError(error)
      return
    }
    createdKeyId = null
    state.value = 'approved'
  }
  catch (error) {
    console.error('Cannot approve agent claim request', error)
    await deleteUnusedKey()
    state.value = 'error'
  }
}

async function deny(): Promise<void> {
  if (!attemptToken.value)
    return
  state.value = 'submitting'
  const { error } = await invokeCapgoApi('private/agent_identity/deny', {
    client: capgo,
    method: 'POST',
    body: { claim_attempt_token: attemptToken.value },
  })
  state.value = error ? await stateForError(error) : 'denied'
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
          {{ t('agent-claim-title') }}
        </h1>
      </header>

      <div v-if="state === 'loading'" role="status" class="flex items-center gap-3 text-slate-600 dark:text-slate-300">
        <span class="d-loading d-loading-spinner d-loading-md text-primary" aria-hidden="true" />
        <span>{{ t('agent-claim-loading') }}</span>
      </div>

      <p v-else-if="state === 'expired'" class="d-alert d-alert-warning">
        {{ t('agent-claim-expired') }}
      </p>

      <p v-else-if="state === 'error'" class="d-alert d-alert-error">
        {{ t('agent-claim-error') }}
      </p>

      <p v-else-if="state === 'wrong-account'" class="d-alert d-alert-warning">
        {{ t('agent-claim-wrong-account', { email: details?.login_hint ?? '' }) }}
      </p>

      <p v-else-if="state === 'denied'" class="text-slate-600 dark:text-slate-300">
        {{ t('agent-claim-denied') }}
      </p>

      <div v-else-if="state === 'approved'" role="status" class="flex items-center gap-3 text-slate-600 dark:text-slate-300">
        <IconCheckCircle class="h-5 w-5 text-emerald-500" aria-hidden="true" />
        <span>{{ t('agent-claim-approved') }}</span>
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
          {{ t('agent-claim-description') }}
        </p>

        <div class="space-y-2">
          <label for="agent-claim-code" class="block text-sm font-semibold text-slate-900 dark:text-slate-100">
            {{ t('agent-claim-code-label') }}
          </label>
          <input
            id="agent-claim-code"
            v-model="userCode"
            class="d-input d-input-bordered w-full font-mono text-lg tracking-[0.4em]"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="7"
            required
            :aria-invalid="codeError ? 'true' : 'false'"
            :aria-describedby="codeError ? 'agent-claim-code-error' : undefined"
            @input="codeError = ''"
          >
          <p v-if="codeError" id="agent-claim-code-error" class="text-sm text-red-600" role="alert">
            {{ codeError }}
          </p>
        </div>

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
            <span>{{ t('agent-claim-unverified') }}</span>
          </p>
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
