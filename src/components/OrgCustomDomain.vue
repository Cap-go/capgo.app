<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { invokeCapgoApi, isRetryableInvokeError } from '~/services/capgoApi'

interface Domain {
  hostname: string
  status: 'pending' | 'active'
  hostname_status: string
  certificate_status: string
  dns_records: Array<{ type: string, name: string, value: string }>
  errors: string[]
  endpoints: { updateUrl: string, statsUrl: string, channelUrl: string } | null
}

const props = defineProps<{ orgId: string }>()
const { t } = useI18n()
const hostname = ref('')
const domain = ref<Domain | null>(null)
const busy = ref(false)
const failed = ref(false)
const confirmRemove = ref(false)
const loaded = ref(false)
const refreshDelays = [5000, 15000, 30000, 60000, 120000]
const refreshCount = ref(0)
let sequence = 0
let disposed = false
let refreshTimer: ReturnType<typeof setTimeout> | undefined

function stopRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = undefined
}

function scheduleRefresh() {
  if (disposed || document.visibilityState === 'hidden' || refreshCount.value >= refreshDelays.length)
    return
  refreshTimer = setTimeout(() => {
    refreshCount.value++
    void request('GET', true)
  }, refreshDelays[refreshCount.value])
}

async function request(method: 'GET' | 'POST' | 'DELETE', automatic = false) {
  if (disposed || busy.value)
    return
  stopRefresh()
  if (!automatic)
    refreshCount.value = 0
  const orgId = props.orgId
  const current = ++sequence
  let retry = false
  busy.value = true
  failed.value = false
  try {
    const { data, error } = await invokeCapgoApi<{ domain: Domain | null }>(`private/custom_domains/${orgId}`, {
      method,
      ...(method === 'GET' ? { retries: 0 } : {}),
      ...(method === 'POST' ? { body: { hostname: hostname.value } } : {}),
    })
    if (current !== sequence || orgId !== props.orgId)
      return
    if (error) {
      retry = isRetryableInvokeError(error)
      failed.value = !automatic || !retry
      return
    }
    domain.value = method === 'DELETE' ? null : data?.domain ?? null
    loaded.value = true
    if (method !== 'GET')
      confirmRemove.value = false
    retry = domain.value?.status === 'pending'
  }
  catch (error) {
    if (current === sequence) {
      retry = isRetryableInvokeError(error)
      failed.value = !automatic || !retry
    }
  }
  finally {
    if (current === sequence) {
      busy.value = false
      if (retry)
        scheduleRefresh()
    }
  }
}

watch(() => props.orgId, () => {
  sequence++
  stopRefresh()
  busy.value = false
  loaded.value = false
  domain.value = null
  hostname.value = ''
  confirmRemove.value = false
  void request('GET')
}, { immediate: true })

function refreshWhenVisible() {
  if (document.visibilityState === 'hidden') {
    stopRefresh()
    return
  }
  if (!busy.value && (!loaded.value || domain.value?.status === 'pending'))
    void request('GET')
}

onMounted(() => document.addEventListener('visibilitychange', refreshWhenVisible))
onBeforeUnmount(() => {
  disposed = true
  sequence++
  stopRefresh()
  document.removeEventListener('visibilitychange', refreshWhenVisible)
})

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(t('custom-domain-copied'))
  }
  catch {
    toast.error(t('cannot-copy'))
  }
}
</script>

<template>
  <section class="p-4 mt-6 mb-6 border rounded-lg border-slate-200 dark:border-slate-700" data-test="custom-domain-settings" :aria-busy="busy">
    <h3 class="text-base font-semibold text-slate-800 dark:text-white">
      {{ t('custom-domain-title') }}
    </h3>
    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
      {{ t('custom-domain-description') }}
    </p>
    <p v-if="failed" class="mt-3 text-sm text-red-600" role="alert">
      {{ t('custom-domain-error') }}
    </p>
    <form v-if="loaded && !domain" class="flex flex-wrap items-end gap-3 mt-4" @submit.prevent="request('POST')">
      <div class="flex-1 min-w-48">
        <label for="org-custom-domain-hostname" class="block mb-1 text-sm">{{ t('custom-domain-hostname') }}</label>
        <input id="org-custom-domain-hostname" v-model="hostname" class="d-input d-input-bordered w-full" placeholder="updates.example.com" required maxlength="253" :disabled="busy" autocomplete="off" spellcheck="false">
      </div>
      <button type="submit" class="d-btn d-btn-primary" :disabled="busy || !hostname.trim()">
        {{ t('custom-domain-add') }}
      </button>
    </form>
    <div v-else-if="domain" class="mt-4 space-y-3">
      <div class="flex flex-wrap items-center gap-3">
        <strong>{{ domain.hostname }}</strong>
        <span class="d-badge" :class="domain.status === 'active' ? 'd-badge-success' : 'd-badge-warning'">{{ t(`custom-domain-${domain.status}`) }}</span>
      </div>
      <p v-if="domain.status === 'pending' && !failed && refreshCount < refreshDelays.length" class="text-sm text-slate-500" role="status">
        {{ t('custom-domain-verifying') }}
      </p>
      <p class="text-sm text-slate-500">
        {{ t('custom-domain-dns-help') }}
      </p>
      <div class="overflow-x-auto">
        <table class="d-table d-table-sm w-full">
          <caption class="sr-only">
            {{ t('custom-domain-dns-records') }}
          </caption>
          <thead><tr><th>{{ t('custom-domain-record-type') }}</th><th>{{ t('custom-domain-record-name') }}</th><th>{{ t('custom-domain-record-value') }}</th></tr></thead>
          <tbody>
            <tr v-for="record in domain.dns_records" :key="`${record.type}:${record.name}:${record.value}`">
              <td>{{ record.type.toUpperCase() }}</td><td><code>{{ record.name }}</code></td>
              <td>
                <button class="text-left break-all cursor-pointer hover:underline" :title="t('custom-domain-copy')" @click="copy(record.value)">
                  <code>{{ record.value }}</code>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-for="error in domain.errors" :key="error" class="text-sm text-red-600">
        {{ error }}
      </p>
      <div v-if="domain.endpoints" class="space-y-2">
        <p class="text-sm">
          {{ t('custom-domain-config-help') }}
        </p>
        <pre class="p-3 overflow-x-auto text-sm rounded bg-slate-100 dark:bg-slate-800">{{ JSON.stringify({ plugins: { CapacitorUpdater: domain.endpoints } }, null, 2) }}</pre>
        <button class="d-btn d-btn-sm" @click="copy(JSON.stringify({ plugins: { CapacitorUpdater: domain.endpoints } }, null, 2))">
          {{ t('custom-domain-copy-config') }}
        </button>
      </div>
      <p class="text-sm text-slate-500">
        {{ t('custom-domain-remove-warning') }}
      </p>
      <div v-if="confirmRemove" class="flex flex-wrap items-center gap-3">
        <button class="d-btn d-btn-sm d-btn-error" :disabled="busy" @click="request('DELETE')">
          {{ t('custom-domain-confirm-remove') }}
        </button>
        <button class="d-btn d-btn-sm" :disabled="busy" @click="confirmRemove = false">
          {{ t('button-cancel') }}
        </button>
      </div>
      <button v-else class="d-btn d-btn-sm d-btn-outline" :disabled="busy" @click="confirmRemove = true">
        {{ t('custom-domain-remove') }}
      </button>
    </div>
    <a class="inline-block mt-4 text-sm underline" href="https://capgo.app/docs/live-updates/custom-domain/" target="_blank" rel="noopener noreferrer">{{ t('custom-domain-guide') }}</a>
  </section>
</template>
