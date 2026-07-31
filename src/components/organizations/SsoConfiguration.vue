<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/heroicons/document-duplicate'
import IconGlobeAlt from '~icons/heroicons/globe-alt'
import IconTrash from '~icons/heroicons/trash'
import Spinner from '~/components/Spinner.vue'
import { formatLocalDate } from '~/services/date'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'

interface SsoProvider {
  id: string
  org_id: string
  domain: string
  provider_id: string | null
  status: 'pending_verification' | 'verified' | 'active' | 'disabled'
  enforce_sso: boolean
  metadata_url: string
  dns_verification_token: string | null
  created_at: string
  updated_at: string
}

const props = defineProps<{
  orgId: string
}>()

const { t } = useI18n()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()

interface SpMetadata {
  acs_url: string
  entity_id: string
  sp_metadata_url: string
  nameid_format: string
}

const providers = ref<SsoProvider[]>([])
const spMetadata = ref<SpMetadata | null>(null)
const isLoading = ref(true)
const isSubmitting = ref(false)
const isVerifying = ref<string | null>(null)
const showAddForm = ref(false)

// Form fields
const newDomain = ref('')
const newMetadataUrl = ref('')

// Track recently created provider to show DNS token
const recentlyCreatedId = ref<string | null>(null)

// Track pending verification provider to show DNS token
const pendingVerificationProvider = computed(() => {
  // First, check if there's a recently created provider
  if (recentlyCreatedId.value) {
    const recent = providers.value.find(p => p.id === recentlyCreatedId.value)
    if (recent && recent.status === 'pending_verification' && recent.dns_verification_token)
      return recent
  }
  // Otherwise, find the first pending verification provider
  return providers.value.find(p =>
    p.status === 'pending_verification' && p.dns_verification_token,
  ) ?? null
})

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: currentSession } = await supabase.auth.getSession()
  if (!currentSession.session)
    throw new Error('Not authenticated')

  return {
    'Content-Type': 'application/json',
    'authorization': `Bearer ${currentSession.session.access_token}`,
  }
}
async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('sso-copied-to-clipboard', { label }))
  }
  catch (error) {
    console.error('Failed to copy to clipboard:', error)
    toast.error(t('sso-copy-failed'))
  }
}

async function fetchProviders() {
  isLoading.value = true
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/providers/${props.orgId}`, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      console.error('Failed to fetch SSO providers:', response.status)
      toast.error(t('sso-error-loading'))
      return
    }

    const data = await response.json() as SsoProvider[]
    providers.value = data
  }
  catch (error) {
    console.error('Error fetching SSO providers:', error)
    toast.error(t('sso-error-loading'))
  }
  finally {
    isLoading.value = false
  }
}

async function fetchSpMetadata() {
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/sp-metadata`, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      console.error('Failed to fetch SSO SP metadata:', response.status)
      spMetadata.value = null
      toast.error(t('sso-error-loading-sp-metadata'))
      return
    }

    const data = await response.json() as {
      acs_url: string
      entity_id: string
      nameid_format: string
      sp_metadata_url?: string
    }
    spMetadata.value = {
      acs_url: data.acs_url,
      entity_id: data.entity_id,
      sp_metadata_url: data.sp_metadata_url ?? data.entity_id,
      nameid_format: data.nameid_format,
    }
  }
  catch (error) {
    console.error('Error fetching SSO SP metadata:', error)
    spMetadata.value = null
    toast.error(t('sso-error-loading-sp-metadata'))
  }
}

async function addProvider() {
  if (!newDomain.value.trim() || !newMetadataUrl.value.trim()) {
    toast.error(t('sso-fill-all-fields'))
    return
  }

  isSubmitting.value = true
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        org_id: props.orgId,
        domain: newDomain.value.trim(),
        metadata_url: newMetadataUrl.value.trim(),
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string }
      toast.error(errorData.error || t('sso-error-creating'))
      return
    }

    const created = await response.json() as SsoProvider
    providers.value.push(created)
    recentlyCreatedId.value = created.id

    // Reset form
    newDomain.value = ''
    newMetadataUrl.value = ''
    showAddForm.value = false

    toast.success(t('sso-provider-created'))
  }
  catch (error) {
    console.error('Error creating SSO provider:', error)
    toast.error(t('sso-error-creating'))
  }
  finally {
    isSubmitting.value = false
  }
}

async function verifyDns(providerId: string) {
  isVerifying.value = providerId
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/verify-dns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider_id: providerId }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string }
      toast.error(errorData.error || t('sso-dns-verification-failed'))
      return
    }

    // Refresh to get updated status
    await fetchProviders()
    toast.success(t('sso-dns-verified'))
  }
  catch (error) {
    console.error('Error verifying DNS:', error)
    toast.error(t('sso-dns-verification-failed'))
  }
  finally {
    isVerifying.value = null
  }
}

async function deleteProvider(provider: SsoProvider) {
  dialogStore.openDialog({
    title: t('sso-delete-title'),
    description: t('sso-delete-confirm', { domain: provider.domain }),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-delete'),
        role: 'danger',
        handler: async () => {
          try {
            const headers = await getAuthHeaders()
            const response = await fetch(`${defaultApiHost}/private/sso/providers/${provider.id}`, {
              method: 'DELETE',
              headers,
            })

            if (!response.ok) {
              toast.error(t('sso-error-deleting'))
              return
            }

            providers.value = providers.value.filter(p => p.id !== provider.id)
            if (recentlyCreatedId.value === provider.id)
              recentlyCreatedId.value = null

            toast.success(t('sso-provider-deleted'))
          }
          catch (error) {
            console.error('Error deleting SSO provider:', error)
            toast.error(t('sso-error-deleting'))
          }
        },
      },
    ],
  })
}

async function updateProviderStatus(providerId: string, status: 'active' | 'disabled') {
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/providers/${providerId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string }
      toast.error(errorData.error || t('sso-error-updating'))
      return false
    }

    const updated = await response.json() as SsoProvider
    const index = providers.value.findIndex(p => p.id === providerId)
    if (index !== -1)
      providers.value[index] = updated

    toast.success(status === 'active' ? t('sso-activated') : t('sso-deactivated'))
    return true
  }
  catch (error) {
    console.error('Error updating SSO provider status:', error)
    toast.error(t('sso-error-updating'))
    return false
  }
}

async function toggleEnforceSso(provider: SsoProvider) {
  try {
    const headers = await getAuthHeaders()
    const newValue = !provider.enforce_sso
    const response = await fetch(`${defaultApiHost}/private/sso/providers/${provider.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enforce_sso: newValue }),
    })

    if (!response.ok) {
      toast.error(t('sso-error-updating'))
      return
    }

    const updated = await response.json() as SsoProvider
    const index = providers.value.findIndex(p => p.id === provider.id)
    if (index !== -1)
      providers.value[index] = updated

    toast.success(newValue ? t('sso-enforcement-enabled') : t('sso-enforcement-disabled'))
  }
  catch (error) {
    console.error('Error toggling SSO enforcement:', error)
    toast.error(t('sso-error-updating'))
  }
}

function getStatusBadgeClass(status: SsoProvider['status']): string {
  switch (status) {
    case 'active':
      return 'text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400'
    case 'verified':
      return 'text-blue-700 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400'
    case 'pending_verification':
      return 'text-amber-700 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400'
    case 'disabled':
      return 'text-gray-700 bg-gray-100 dark:bg-gray-700 dark:text-gray-300'
    default:
      return 'text-gray-700 bg-gray-100 dark:bg-gray-700 dark:text-gray-300'
  }
}

function getStatusLabel(status: SsoProvider['status']): string {
  switch (status) {
    case 'active':
      return t('sso-status-active')
    case 'verified':
      return t('sso-status-verified')
    case 'pending_verification':
      return t('sso-status-pending')
    case 'disabled':
      return t('sso-status-disabled')
    default:
      return status
  }
}

function formatDate(dateString: string): string {
  return formatLocalDate(dateString) || '-'
}

onMounted(async () => {
  await Promise.all([fetchProviders(), fetchSpMetadata()])
})

// Expose showAddForm so parent can control it
defineExpose({
  showAddForm,
})
</script>

<template>
  <!-- Service Provider Metadata (shown when available) -->
  <div
    v-if="spMetadata"
    class="p-4 mb-6 border rounded-lg border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"
  >
    <h4 class="mb-1 text-base font-semibold dark:text-white text-slate-800">
      {{ t('sso-service-provider-metadata') }}
    </h4>
    <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
      {{ t('sso-metadata-description') }}
    </p>
    <div class="p-3 space-y-2 font-mono text-sm bg-white border border-slate-200 rounded dark:bg-gray-800 dark:border-slate-700">
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400 min-w-0">
          <span class="font-semibold text-slate-800 dark:text-white">{{ t('sso-acs-url') }}:</span>
          <span class="ml-1 break-all">{{ spMetadata.acs_url }}</span>
        </p>
        <button
          class="d-btn d-btn-ghost d-btn-xs flex-shrink-0"
          :title="t('sso-copy')"
          :aria-label="`${t('sso-copy')} ${t('sso-acs-url')}`"
          @click="copyToClipboard(spMetadata.acs_url, t('sso-acs-url'))"
        >
          <IconCopy class="w-4 h-4" />
        </button>
      </div>
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400 min-w-0">
          <span class="font-semibold text-slate-800 dark:text-white">{{ t('sso-entity-id') }}:</span>
          <span class="ml-1 break-all">{{ spMetadata.entity_id }}</span>
        </p>
        <button
          class="d-btn d-btn-ghost d-btn-xs flex-shrink-0"
          :title="t('sso-copy')"
          :aria-label="`${t('sso-copy')} ${t('sso-entity-id')}`"
          @click="copyToClipboard(spMetadata.entity_id, t('sso-entity-id'))"
        >
          <IconCopy class="w-4 h-4" />
        </button>
      </div>
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400 min-w-0">
          <span class="font-semibold text-slate-800 dark:text-white">{{ t('sso-sp-metadata-url') }}:</span>
          <span class="ml-1 break-all">{{ spMetadata.sp_metadata_url }}</span>
        </p>
        <button
          class="d-btn d-btn-ghost d-btn-xs flex-shrink-0"
          :title="t('sso-copy')"
          :aria-label="`${t('sso-copy')} ${t('sso-sp-metadata-url')}`"
          @click="copyToClipboard(spMetadata.sp_metadata_url, t('sso-sp-metadata-url'))"
        >
          <IconCopy class="w-4 h-4" />
        </button>
      </div>
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400 min-w-0">
          <span class="font-semibold text-slate-800 dark:text-white">{{ t('sso-nameid-format') }}:</span>
          <span class="ml-1 break-all">{{ spMetadata.nameid_format }}</span>
        </p>
        <button
          class="d-btn d-btn-ghost d-btn-xs flex-shrink-0"
          :title="t('sso-copy')"
          :aria-label="`${t('sso-copy')} ${t('sso-nameid-format')}`"
          @click="copyToClipboard(spMetadata.nameid_format, t('sso-nameid-format'))"
        >
          <IconCopy class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>

  <!-- Add Provider Form -->
  <div
    v-if="showAddForm"
    class="p-4 mb-6 border rounded-lg border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"
  >
    <h4 class="mb-4 text-base font-semibold dark:text-white text-slate-800">
      {{ t('sso-new-provider') }}
    </h4>
    <div class="space-y-4">
      <div>
        <label for="sso-new-domain" class="block mb-1 text-sm font-medium dark:text-white text-slate-700">
          {{ t('sso-domain') }}
        </label>
        <input
          id="sso-new-domain"
          v-model="newDomain"
          type="text"
          :placeholder="t('sso-domain-placeholder')"
          :aria-label="t('sso-domain')"
          :disabled="isSubmitting"
          class="d-input d-input-bordered w-full"
        >
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ t('sso-domain-help') }}
        </p>
      </div>
      <div>
        <label for="sso-new-metadata-url" class="block mb-1 text-sm font-medium dark:text-white text-slate-700">
          {{ t('sso-metadata-url') }}
        </label>
        <input
          id="sso-new-metadata-url"
          v-model="newMetadataUrl"
          type="url"
          :placeholder="t('sso-metadata-url-placeholder')"
          :aria-label="t('sso-metadata-url')"
          :disabled="isSubmitting"
          class="d-input d-input-bordered w-full"
        >
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ t('sso-metadata-url-help') }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <button
          :disabled="isSubmitting"
          class="d-btn d-btn-primary d-btn-sm"
          :class="{ 'd-btn-disabled': isSubmitting }"
          @click="addProvider"
        >
          <span v-if="isSubmitting" class="flex items-center gap-2">
            <Spinner size="w-4 h-4" />
            {{ t('sso-creating') }}
          </span>
          <span v-else>{{ t('sso-create-provider') }}</span>
        </button>
        <button
          :disabled="isSubmitting"
          class="d-btn d-btn-outline d-btn-sm"
          @click="showAddForm = false"
        >
          {{ t('button-cancel') }}
        </button>
      </div>
    </div>
  </div>

  <!-- DNS Verification Instructions (shown after creation) -->
  <div
    v-if="pendingVerificationProvider"
    class="p-4 mb-6 border rounded-lg border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20"
  >
    <h4 class="mb-2 font-semibold text-blue-800 dark:text-blue-200">
      {{ t('sso-dns-verification-required') }}
    </h4>
    <p class="mb-3 text-sm text-blue-700 dark:text-blue-300">
      {{ t('sso-dns-verification-instructions') }}
    </p>
    <div class="p-3 mb-3 space-y-2 font-mono text-sm bg-white border border-blue-200 rounded dark:bg-gray-800 dark:border-blue-700">
      <p class="text-slate-600 dark:text-slate-400">
        {{ t('sso-dns-record-type') }}: <span class="font-semibold text-slate-800 dark:text-white">TXT</span>
      </p>
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400">
          {{ t('sso-dns-record-name') }}: <span class="font-semibold text-slate-800 dark:text-white">_capgo-sso.{{ pendingVerificationProvider.domain }}</span>
        </p>
        <button
          class="d-btn d-btn-ghost d-btn-xs"
          :title="t('sso-copy')"
          @click="copyToClipboard(`_capgo-sso.${pendingVerificationProvider.domain}`, t('sso-dns-record-name'))"
        >
          <IconCopy class="w-4 h-4" />
        </button>
      </div>
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400 break-all">
          {{ t('sso-dns-record-value') }}: <span class="font-semibold text-slate-800 dark:text-white">{{ pendingVerificationProvider.dns_verification_token }}</span>
        </p>
        <button
          class="d-btn d-btn-ghost d-btn-xs flex-shrink-0"
          :title="t('sso-copy')"
          @click="copyToClipboard(pendingVerificationProvider.dns_verification_token!, t('sso-dns-record-value'))"
        >
          <IconCopy class="w-4 h-4" />
        </button>
      </div>
    </div>

    <div class="flex items-center gap-3">
      <button
        :disabled="isVerifying === pendingVerificationProvider.id"
        class="d-btn d-btn-primary d-btn-sm"
        :class="{ 'd-btn-disabled': isVerifying === pendingVerificationProvider.id }"
        @click="verifyDns(pendingVerificationProvider.id)"
      >
        <span v-if="isVerifying === pendingVerificationProvider.id" class="flex items-center gap-2">
          <Spinner size="w-4 h-4" />
          {{ t('sso-verifying') }}
        </span>
        <span v-else>{{ t('sso-verify-dns') }}</span>
      </button>
      <button
        class="d-btn d-btn-outline d-btn-sm"
        @click="recentlyCreatedId = null"
      >
        {{ t('sso-dismiss') }}
      </button>
    </div>
  </div>

  <!-- Loading State -->
  <div v-if="isLoading" class="flex items-center justify-center py-12">
    <Spinner size="w-8 h-8" color="fill-blue-500 text-gray-200 dark:text-gray-600" />
  </div>

  <!-- Empty State -->
  <div
    v-else-if="providers.length === 0 && !showAddForm"
    class="py-12 text-center"
  >
    <div class="flex justify-center mb-4">
      <div class="p-4 bg-gray-100 rounded-full dark:bg-gray-700">
        <IconGlobeAlt class="w-12 h-12 text-gray-400" />
      </div>
    </div>
    <h4 class="text-lg font-medium text-gray-900 dark:text-white">
      {{ t('sso-no-providers') }}
    </h4>
    <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
      {{ t('sso-no-providers-description') }}
    </p>
    <button
      class="d-btn d-btn-primary d-btn-sm mt-4"
      @click="showAddForm = true"
    >
      {{ t('sso-add-provider') }}
    </button>
  </div>

  <!-- Providers List -->
  <div v-else class="space-y-3">
    <div
      v-for="provider in providers"
      :key="provider.id"
      class="d-card d-card-bordered"
    >
      <div class="d-card-body p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-3">
            <h4 class="text-sm font-semibold truncate dark:text-white text-slate-800">
              {{ provider.domain }}
            </h4>
            <span
              class="px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap"
              :class="getStatusBadgeClass(provider.status)"
            >
              {{ getStatusLabel(provider.status) }}
            </span>
          </div>
          <p class="mt-1 text-xs truncate text-slate-500 dark:text-slate-400">
            {{ provider.metadata_url }}
          </p>
          <p class="mt-1 text-xs text-slate-400 dark:text-slate-500">
            {{ t('created-at') }}: {{ formatDate(provider.created_at) }}
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <!-- Verify DNS button (pending_verification) -->
          <button
            v-if="provider.status === 'pending_verification'"
            :disabled="isVerifying === provider.id"
            class="d-btn d-btn-primary d-btn-sm"
            :class="{ 'd-btn-disabled': isVerifying === provider.id }"
            @click="verifyDns(provider.id)"
          >
            <Spinner v-if="isVerifying === provider.id" size="w-4 h-4" />
            <span>{{ t('sso-verify-dns') }}</span>
          </button>

          <!-- Activate button (verified) -->
          <button
            v-if="provider.status === 'verified'"
            class="d-btn d-btn-success d-btn-sm"
            @click="updateProviderStatus(provider.id, 'active')"
          >
            {{ t('sso-activate') }}
          </button>

          <!-- Deactivate button (active) -->
          <button
            v-if="provider.status === 'active'"
            class="d-btn d-btn-warning d-btn-outline d-btn-sm"
            @click="updateProviderStatus(provider.id, 'disabled')"
          >
            {{ t('sso-deactivate') }}
          </button>

          <!-- Re-activate button (disabled) -->
          <button
            v-if="provider.status === 'disabled'"
            class="d-btn d-btn-success d-btn-outline d-btn-sm"
            @click="updateProviderStatus(provider.id, 'active')"
          >
            {{ t('sso-reactivate') }}
          </button>

          <!-- Enforce SSO toggle (active only) -->
          <label
            v-if="provider.status === 'active'"
            class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
            :title="t('sso-enforce-tooltip')"
          >
            <input
              type="checkbox"
              :checked="provider.enforce_sso"
              class="d-toggle d-toggle-primary"
              @change="toggleEnforceSso(provider)"
            >
            <span class="text-slate-700 dark:text-slate-300">{{ t('sso-enforce') }}</span>
          </label>

          <!-- Delete button (always visible) -->
          <button
            class="d-btn d-btn-error d-btn-outline d-btn-sm"
            @click="deleteProvider(provider)"
          >
            <IconTrash class="w-4 h-4" />
            {{ t('delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
