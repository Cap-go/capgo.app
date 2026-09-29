<script setup lang="ts">
import { FunctionsHttpError } from '@supabase/supabase-js'
import { computed, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invokeCapgoApi } from '~/services/capgoApi'
import { isAdminRole, isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const route = useRoute()
const organizationStore = useOrganizationStore()
const orgSelectId = useId()

const clientName = ref('')
const loadingClient = ref(true)
const submitting = ref(false)
const errorMessage = ref('')

const clientId = computed(() => stringQuery('client_id'))
const redirectUri = computed(() => stringQuery('redirect_uri'))
const state = computed(() => stringQuery('state'))
const codeChallenge = computed(() => stringQuery('code_challenge'))
const codeChallengeMethod = computed(() => stringQuery('code_challenge_method'))
const resource = computed(() => stringQuery('resource'))
const paramsReady = computed(() => Boolean(clientId.value && redirectUri.value && state.value && codeChallenge.value))

const orgs = computed(() =>
  organizationStore.organizations
    .filter(org => isAdminRole(org.role) && !isPendingOrganizationInvite(org))
    .map(org => ({ id: org.gid, name: org.name })),
)
const orgId = ref('')

function stringQuery(key: string): string {
  const value = route.query[key]
  return typeof value === 'string' ? value : ''
}

async function readError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError && error.context instanceof Response) {
    const body = await error.context.clone().json().catch(() => null) as { error_description?: string, message?: string } | null
    return body?.error_description || body?.message || t('mcp-authorize-failed')
  }
  return error instanceof Error ? error.message : t('mcp-authorize-failed')
}

watch(orgs, (list) => {
  if (!orgId.value && list.length === 1)
    orgId.value = list[0]?.id ?? ''
}, { immediate: true })

onMounted(async () => {
  if (!clientId.value) {
    loadingClient.value = false
    return
  }
  const { data, error } = await invokeCapgoApi<{ client_name?: string }>(`mcp/oauth/client/${encodeURIComponent(clientId.value)}`, {
    method: 'GET',
  })
  loadingClient.value = false
  if (error) {
    errorMessage.value = await readError(error)
    return
  }
  clientName.value = data?.client_name || t('mcp-authorize-unknown-client')
})

async function finish(decision: 'allow' | 'deny') {
  errorMessage.value = ''
  if (!paramsReady.value) {
    errorMessage.value = t('mcp-authorize-missing')
    return
  }
  submitting.value = true
  const { data, error } = await invokeCapgoApi<{ redirect_to?: string }>('mcp/oauth/approve', {
    method: 'POST',
    body: {
      decision,
      client_id: clientId.value,
      redirect_uri: redirectUri.value,
      state: state.value,
      code_challenge: codeChallenge.value,
      code_challenge_method: codeChallengeMethod.value || 'S256',
      resource: resource.value || undefined,
      org_id: decision === 'allow' ? orgId.value : undefined,
    },
  })
  submitting.value = false
  if (error || !data?.redirect_to) {
    errorMessage.value = error ? await readError(error) : t('mcp-authorize-failed')
    return
  }
  window.location.assign(data.redirect_to)
}
</script>

<route lang="yaml">
meta:
  layout: naked
</route>

<template>
  <main class="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
    <section class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
      <h1 class="text-2xl font-semibold text-white">
        {{ t('mcp-authorize-title') }}
      </h1>
      <p class="mt-2 text-sm text-slate-300">
        {{ t('mcp-authorize-subtitle') }}
      </p>

      <p v-if="!paramsReady" class="mt-6 text-sm text-red-300" role="alert">
        {{ t('mcp-authorize-missing') }}
      </p>

      <form v-else class="mt-6 space-y-4" @submit.prevent="finish('allow')">
        <div>
          <p class="text-xs font-medium tracking-wide text-slate-400 uppercase">
            {{ t('mcp-authorize-client') }}
          </p>
          <p class="mt-1 text-base text-white">
            {{ loadingClient ? t('mcp-authorize-loading') : (clientName || t('mcp-authorize-unknown-client')) }}
          </p>
        </div>

        <div>
          <label :for="orgSelectId" class="text-sm font-medium text-slate-200">
            {{ t('mcp-authorize-org') }}
          </label>
          <select
            :id="orgSelectId"
            v-model="orgId"
            class="d-select mt-1 w-full border-slate-600 bg-slate-950 text-slate-100"
            required
          >
            <option value="" disabled>
              {{ t('mcp-authorize-org-placeholder') }}
            </option>
            <option v-for="org in orgs" :key="org.id" :value="org.id">
              {{ org.name }}
            </option>
          </select>
          <p v-if="orgs.length === 0" class="mt-2 text-sm text-amber-200">
            {{ t('mcp-authorize-no-org') }}
          </p>
        </div>

        <p class="text-sm text-slate-400">
          {{ t('mcp-authorize-scope') }}
          {{ t('mcp-authorize-revoke-hint') }}
        </p>

        <p v-if="errorMessage" class="text-sm text-red-300" role="alert">
          {{ errorMessage }}
        </p>

        <div class="flex gap-3">
          <button type="button" class="d-btn flex-1" :disabled="submitting" @click="finish('deny')">
            {{ t('mcp-authorize-deny') }}
          </button>
          <button type="submit" class="d-btn d-btn-primary flex-1" :disabled="submitting || !orgId">
            {{ t('mcp-authorize-allow') }}
          </button>
        </div>
      </form>
    </section>
  </main>
</template>
