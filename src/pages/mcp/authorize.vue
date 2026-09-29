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
const clientHost = computed(() => {
  try {
    return new URL(redirectUri.value).host
  }
  catch {
    return ''
  }
})

const cardClass = [
  'rounded-none border-0 bg-transparent p-0 shadow-none',
  'sm:rounded-[1.75rem] sm:border sm:border-slate-200/75 sm:bg-[linear-gradient(180deg,rgba(255,255,255,0.94)_0%,rgba(255,255,255,0.84)_100%)]',
  'sm:p-7 sm:shadow-[0_34px_80px_-42px_rgba(15,23,42,0.5)] sm:backdrop-blur-[18px]',
  'sm:dark:border-slate-600/70 sm:dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.88)_0%,rgba(15,23,42,0.7)_100%)] sm:dark:shadow-none',
].join(' ')
const primaryButtonClass = [
  'inline-flex w-full items-center justify-center rounded-xl px-4 py-4 text-base font-semibold text-white',
  'bg-[linear-gradient(135deg,rgba(36,67,102,1)_0%,rgba(12,110,184,1)_100%)] shadow-[0_20px_38px_-26px_rgba(17,158,255,0.85)]',
  'hover:brightness-105',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-azure-500)]',
  'disabled:pointer-events-none disabled:opacity-60',
].join(' ')
const secondaryButtonClass = [
  'inline-flex w-full items-center justify-center rounded-xl border border-slate-400/55 bg-white/92 px-4 py-4 text-base font-semibold text-slate-700',
  'hover:border-[rgba(17,158,255,0.45)] hover:bg-slate-100/95',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-azure-500)]',
  'dark:border-slate-600/90 dark:bg-slate-950/85 dark:text-slate-200 dark:hover:bg-slate-800/95',
  'disabled:pointer-events-none disabled:opacity-60',
].join(' ')

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
  <main class="relative isolate flex min-h-dvh w-full overflow-y-auto bg-[linear-gradient(180deg,rgba(248,250,252,0.98)_0%,rgba(238,244,255,0.9)_55%,rgba(248,250,252,0.98)_100%)] antialiased dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.98)_0%,rgba(20,29,53,0.96)_52%,rgba(15,23,42,0.98)_100%)]">
    <div class="pointer-events-none absolute inset-0 overflow-hidden max-lg:hidden" aria-hidden="true">
      <div class="absolute top-[10%] -left-32 size-[22rem] rounded-full bg-[rgba(17,158,255,0.22)] opacity-55 blur-[52px]" />
      <div class="absolute right-[-7rem] bottom-[8%] size-[18rem] rounded-full bg-[rgba(104,118,225,0.18)] opacity-55 blur-[52px]" />
    </div>

    <div class="relative mx-auto flex w-full max-w-lg flex-col justify-center gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <div class="flex items-center gap-3">
        <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-200/80 bg-white/80 shadow-sm dark:border-slate-700 dark:bg-slate-900/70 dark:shadow-none">
          <img src="/capgo.webp" alt="Capgo" class="size-7 rounded-sm invert dark:invert-0">
        </span>
        <p class="min-w-0 truncate font-prompt text-base font-medium text-slate-700 dark:text-slate-200">
          Capgo
        </p>
      </div>

      <section :class="cardClass">
        <div class="flex flex-col gap-6">
          <div class="flex flex-col gap-2">
            <h1 class="max-w-[20ch] text-2xl font-semibold tracking-tight text-balance text-slate-950 dark:text-white">
              {{ t('mcp-authorize-title') }}
            </h1>
            <p class="max-w-[42ch] text-base/7 text-pretty text-slate-600 sm:text-sm/6 dark:text-slate-300">
              {{ t('mcp-authorize-subtitle') }}
            </p>
          </div>

          <p v-if="!paramsReady" class="text-base/7 text-red-700 sm:text-sm/6 dark:text-red-300" role="alert">
            {{ t('mcp-authorize-missing') }}
          </p>

          <form v-else class="flex flex-col gap-5" @submit.prevent="finish('allow')">
            <div class="flex flex-col gap-1 rounded-2xl bg-slate-950/5 px-4 py-3 dark:bg-white/5">
              <p class="text-base font-medium text-slate-500 sm:text-sm dark:text-slate-400">
                {{ t('mcp-authorize-client') }}
              </p>
              <p class="text-base font-semibold text-slate-950 dark:text-white">
                {{ loadingClient ? t('mcp-authorize-loading') : (clientName || t('mcp-authorize-unknown-client')) }}
              </p>
              <p v-if="clientHost" class="truncate text-base text-slate-600 sm:text-sm dark:text-slate-300">
                {{ clientHost }}
              </p>
            </div>

            <div class="flex flex-col gap-2">
              <label :for="orgSelectId" class="text-base font-medium text-slate-800 sm:text-sm dark:text-slate-200">
                {{ t('mcp-authorize-org') }}
              </label>
              <div class="grid grid-cols-[1fr_--spacing(8)]">
                <select
                  :id="orgSelectId"
                  v-model="orgId"
                  name="org_id"
                  class="col-span-full row-start-1 appearance-none rounded-xl bg-white py-3 pr-8 pl-3 text-base text-slate-950 ring-1 ring-slate-950/10 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--color-azure-500)] sm:py-2.5 sm:text-sm dark:bg-slate-950 dark:text-white dark:ring-white/10"
                  required
                >
                  <option value="" disabled>
                    {{ t('mcp-authorize-org-placeholder') }}
                  </option>
                  <option v-for="org in orgs" :key="org.id" :value="org.id">
                    {{ org.name }}
                  </option>
                </select>
                <svg viewBox="0 0 8 5" width="8" height="5" fill="none" class="pointer-events-none col-start-2 row-start-1 place-self-center stroke-slate-500" aria-hidden="true">
                  <path d="M.5.5 4 4 7.5.5" stroke-width="1.2" />
                </svg>
              </div>
              <p v-if="orgs.length === 0" class="text-base/7 text-amber-800 sm:text-sm/6 dark:text-amber-200">
                {{ t('mcp-authorize-no-org') }}
              </p>
            </div>

            <div class="flex flex-col gap-2 text-base/7 text-pretty text-slate-600 sm:text-sm/6 dark:text-slate-300">
              <p>{{ t('mcp-authorize-scope') }}</p>
              <p>{{ t('mcp-authorize-revoke-hint') }}</p>
            </div>

            <p v-if="errorMessage" class="text-base/7 text-red-700 sm:text-sm/6 dark:text-red-300" role="alert">
              {{ errorMessage }}
            </p>

            <div class="flex flex-col gap-3 sm:flex-row">
              <button type="button" :class="secondaryButtonClass" class="sm:flex-1" :disabled="submitting" @click="finish('deny')">
                {{ t('mcp-authorize-deny') }}
              </button>
              <button type="submit" :class="primaryButtonClass" class="sm:flex-1" :disabled="submitting || !orgId" :aria-busy="submitting ? 'true' : 'false'">
                {{ t('mcp-authorize-allow') }}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  </main>
</template>
