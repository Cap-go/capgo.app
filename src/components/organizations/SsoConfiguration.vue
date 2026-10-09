<script setup lang="ts">
import type { SsoRoleMapping } from '~/components/organizations/SsoRoleMappingDialog.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/heroicons/document-duplicate'
import IconGlobeAlt from '~icons/heroicons/globe-alt'
import IconLink from '~icons/heroicons/link'
import IconTrash from '~icons/heroicons/trash'
import IconXMark from '~icons/heroicons/x-mark'
import SsoRoleMappingDialog from '~/components/organizations/SsoRoleMappingDialog.vue'
import Spinner from '~/components/Spinner.vue'
import { formatLocalDate } from '~/services/date'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { isSuperAdminRole, useOrganizationStore } from '~/stores/organization'

interface SsoProvider {
  id: string
  org_id: string
  domain: string
  provider_id: string | null
  status: 'pending_verification' | 'verified' | 'active' | 'disabled'
  enforce_sso: boolean
  metadata_url: string | null
  dns_verification_token: string | null
  role_mapping: SsoRoleMapping | null
  created_at: string
  updated_at: string
}

// An org this org's provider is shared with.
interface SharedLink {
  provider_id: string
  org_id: string
  org_name: string
  has_role_mapping: boolean
  created_at: string
}

// A provider another org shares with this org.
interface LinkedProvider {
  provider_id: string
  domain: string
  status: SsoProvider['status']
  owner_org_id: string
  owner_org_name: string
  role_mapping: SsoRoleMapping | null
  created_at: string
}

const props = defineProps<{
  orgId: string
}>()

const SHARE_DIALOG_ID = 'sso-share-provider'

const { t } = useI18n()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()
const organizationStore = useOrganizationStore()

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
const roleMappingDialog = ref<InstanceType<typeof SsoRoleMappingDialog> | null>(null)

const sharedLinks = ref<SharedLink[]>([])
const linkedProviders = ref<LinkedProvider[]>([])
const shareProviderTarget = ref<SsoProvider | null>(null)
const shareOrgId = ref('')

function onRoleMappingSaved(providerId: string, roleMapping: SsoRoleMapping | null, shared: boolean) {
  const provider = shared
    ? linkedProviders.value.find(p => p.provider_id === providerId)
    : providers.value.find(p => p.id === providerId)
  if (provider)
    provider.role_mapping = roleMapping
}

const isOrgSuperAdmin = computed(() => isSuperAdminRole(organizationStore.organizations.find(org => org.gid === props.orgId)?.role))

// Unsharing is allowed to super admins of either org.
function canStopSharing(orgId: string) {
  return isOrgSuperAdmin.value || isSuperAdminRole(organizationStore.organizations.find(org => org.gid === orgId)?.role)
}

function sharedWith(providerId: string) {
  return sharedLinks.value.filter(link => link.provider_id === providerId)
}

// Sharing needs the caller to be super admin of both orgs.
function shareCandidates(providerId: string) {
  return organizationStore.organizations.filter(org =>
    org.gid !== props.orgId
    && isSuperAdminRole(org.role)
    && !sharedWith(providerId).some(link => link.org_id === org.gid),
  )
}
const showAddForm = ref(false)

// Form fields
const newDomain = ref('')
const newMetadataUrl = ref('')
const newMetadataXml = ref('')
const metadataSource = ref<'url' | 'xml'>('url')

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
// Backend errors carry a human readable `message` (e.g. why Supabase Auth could
// not load the IdP metadata); show it instead of the bare error code.
async function readApiError(response: Response, fallback: string): Promise<string> {
  const errorData = await response.json().catch(() => ({})) as { error?: string, message?: string }
  return errorData.message || errorData.error || fallback
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
  // A response for an org the user already switched away from is ignored.
  const orgId = props.orgId
  isLoading.value = true
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/providers/${orgId}`, {
      method: 'GET',
      headers,
    })
    if (orgId !== props.orgId)
      return

    if (!response.ok) {
      console.error('Failed to fetch SSO providers:', response.status)
      toast.error(t('sso-error-loading'))
      return
    }

    const data = await response.json() as SsoProvider[]
    if (orgId === props.orgId)
      providers.value = data
  }
  catch (error) {
    console.error('Error fetching SSO providers:', error)
    toast.error(t('sso-error-loading'))
  }
  finally {
    if (orgId === props.orgId)
      isLoading.value = false
  }
}

async function fetchLinks() {
  const orgId = props.orgId
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/providers/${orgId}/links`, {
      method: 'GET',
      headers,
    })
    if (orgId !== props.orgId)
      return
    if (!response.ok) {
      console.error('Failed to fetch shared SSO providers:', response.status)
      return
    }
    const data = await response.json() as { shared: SharedLink[], linked: LinkedProvider[] }
    if (orgId !== props.orgId)
      return
    sharedLinks.value = data.shared
    linkedProviders.value = data.linked
  }
  catch (error) {
    console.error('Error fetching shared SSO providers:', error)
  }
}

async function shareProvider(): Promise<boolean> {
  const provider = shareProviderTarget.value
  const ownerOrgId = props.orgId
  const org = organizationStore.organizations.find(candidate => candidate.gid === shareOrgId.value)
  if (!provider || !org)
    return false
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${defaultApiHost}/private/sso/providers/${provider.id}/links`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ org_id: org.gid }),
    })
    if (!response.ok) {
      toast.error(await readApiError(response, t('sso-error-sharing')))
      return false
    }
    const link = await response.json() as { created_at: string }
    if (ownerOrgId !== props.orgId)
      return true
    sharedLinks.value.push({ provider_id: provider.id, org_id: org.gid, org_name: org.name, has_role_mapping: false, created_at: link.created_at })
    toast.success(t('sso-shared', { org: org.name }))
    return true
  }
  catch (error) {
    console.error('Error sharing SSO provider:', error)
    toast.error(t('sso-error-sharing'))
    return false
  }
}

function openShareDialog(provider: SsoProvider) {
  shareProviderTarget.value = provider
  shareOrgId.value = shareCandidates(provider.id)[0]?.gid ?? ''
  dialogStore.openDialog({
    id: SHARE_DIALOG_ID,
    title: t('sso-share-title', { domain: provider.domain }),
    description: t('sso-share-description'),
    buttons: [
      { text: t('button-cancel'), role: 'cancel' },
      ...(shareCandidates(provider.id).length > 0
        ? [{ text: t('sso-share'), role: 'primary' as const, handler: shareProvider }]
        : []),
    ],
  })
}

function stopSharing(providerId: string, orgId: string, domain: string, orgName: string) {
  dialogStore.openDialog({
    title: t('sso-stop-sharing'),
    description: t('sso-stop-sharing-confirm', { domain, org: orgName }),
    buttons: [
      { text: t('button-cancel'), role: 'cancel' },
      {
        text: t('sso-stop-sharing'),
        role: 'danger',
        handler: async () => {
          try {
            const headers = await getAuthHeaders()
            const response = await fetch(`${defaultApiHost}/private/sso/providers/${providerId}/links/${orgId}`, {
              method: 'DELETE',
              headers,
            })
            if (!response.ok) {
              toast.error(await readApiError(response, t('sso-error-updating')))
              return
            }
            sharedLinks.value = sharedLinks.value.filter(link => !(link.provider_id === providerId && link.org_id === orgId))
            linkedProviders.value = linkedProviders.value.filter(link => !(link.provider_id === providerId && orgId === props.orgId))
            toast.success(t('sso-sharing-stopped'))
          }
          catch (error) {
            console.error('Error stopping SSO provider sharing:', error)
            toast.error(t('sso-error-updating'))
          }
        },
      },
    ],
  })
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
  const metadataValue = metadataSource.value === 'url' ? newMetadataUrl.value.trim() : newMetadataXml.value.trim()
  if (!newDomain.value.trim() || !metadataValue) {
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
        ...(metadataSource.value === 'url' ? { metadata_url: metadataValue } : { metadata_xml: metadataValue }),
      }),
    })

    if (!response.ok) {
      toast.error(await readApiError(response, t('sso-error-creating')))
      return
    }

    const created = await response.json() as SsoProvider
    providers.value.push(created)
    recentlyCreatedId.value = created.id

    // Reset form
    newDomain.value = ''
    newMetadataUrl.value = ''
    newMetadataXml.value = ''
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
      toast.error(await readApiError(response, t('sso-dns-verification-failed')))
      return
    }

    const result = await response.json() as { verified: boolean, message?: string }
    if (!result.verified) {
      toast.error(result.message || t('sso-dns-verification-failed'))
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
              toast.error(await readApiError(response, t('sso-error-deleting')))
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
      toast.error(await readApiError(response, t('sso-error-updating')))
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
      toast.error(await readApiError(response, t('sso-error-updating')))
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
  await Promise.all([fetchProviders(), fetchLinks(), fetchSpMetadata()])
})

// The page keeps this component mounted when the user switches orgs.
watch(() => props.orgId, async () => {
  providers.value = []
  sharedLinks.value = []
  linkedProviders.value = []
  recentlyCreatedId.value = null
  // The add form creates the provider in the current org: drop a draft
  // started in the previous one.
  showAddForm.value = false
  newDomain.value = ''
  newMetadataUrl.value = ''
  newMetadataXml.value = ''
  await Promise.all([fetchProviders(), fetchLinks()])
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
    <div class="p-3 space-y-2 font-mono text-sm bg-white border border-slate-200 rounded dark:bg-slate-800/60 dark:border-white/10">
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400 min-w-0">
          <span class="font-semibold text-slate-800 dark:text-white">{{ t('sso-acs-url') }}:</span>
          <span class="ml-1 break-all">{{ spMetadata.acs_url }}</span>
        </p>
        <button
          type="button"
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
          type="button"
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
          type="button"
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
          type="button"
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
        <div class="flex gap-4 mb-2" role="radiogroup" :aria-label="t('sso-metadata-source')">
          <label class="flex items-center gap-2 text-sm dark:text-white text-slate-700">
            <input v-model="metadataSource" type="radio" value="url" class="d-radio d-radio-sm" :disabled="isSubmitting">
            {{ t('sso-metadata-url') }}
          </label>
          <label class="flex items-center gap-2 text-sm dark:text-white text-slate-700">
            <input v-model="metadataSource" type="radio" value="xml" class="d-radio d-radio-sm" :disabled="isSubmitting">
            {{ t('sso-metadata-xml') }}
          </label>
        </div>
        <template v-if="metadataSource === 'url'">
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
        </template>
        <template v-else>
          <label for="sso-new-metadata-xml" class="block mb-1 text-sm font-medium dark:text-white text-slate-700">
            {{ t('sso-metadata-xml') }}
          </label>
          <textarea
            id="sso-new-metadata-xml"
            v-model="newMetadataXml"
            rows="6"
            :placeholder="t('sso-metadata-xml-placeholder')"
            :aria-label="t('sso-metadata-xml')"
            :disabled="isSubmitting"
            class="d-textarea d-textarea-bordered w-full font-mono text-xs"
          />
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('sso-metadata-xml-help') }}
          </p>
        </template>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="button"
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
          type="button"
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
    <div class="p-3 mb-3 space-y-2 font-mono text-sm bg-white border border-blue-200 rounded dark:bg-slate-800/60 dark:border-blue-700">
      <p class="text-slate-600 dark:text-slate-400">
        {{ t('sso-dns-record-type') }}: <span class="font-semibold text-slate-800 dark:text-white">TXT</span>
      </p>
      <div class="flex items-center justify-between gap-2">
        <p class="text-slate-600 dark:text-slate-400">
          {{ t('sso-dns-record-name') }}: <span class="font-semibold text-slate-800 dark:text-white">_capgo-sso.{{ pendingVerificationProvider.domain }}</span>
        </p>
        <button
          type="button"
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
          type="button"
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
        type="button"
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
        type="button"
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
      type="button"
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
            type="button"
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
            type="button"
            class="d-btn d-btn-success d-btn-sm"
            @click="updateProviderStatus(provider.id, 'active')"
          >
            {{ t('sso-activate') }}
          </button>

          <!-- Deactivate button (active) -->
          <button
            v-if="provider.status === 'active'"
            type="button"
            class="d-btn d-btn-warning d-btn-outline d-btn-sm"
            @click="updateProviderStatus(provider.id, 'disabled')"
          >
            {{ t('sso-deactivate') }}
          </button>

          <!-- Re-activate button (disabled) -->
          <button
            v-if="provider.status === 'disabled'"
            type="button"
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

          <button
            v-if="provider.status !== 'pending_verification'"
            type="button"
            class="d-btn d-btn-outline d-btn-sm"
            @click="roleMappingDialog?.open(provider)"
          >
            {{ t('sso-role-mapping-title') }}
          </button>

          <!-- Delete button (always visible) -->
          <button
            type="button"
            class="d-btn d-btn-error d-btn-outline d-btn-sm"
            @click="deleteProvider(provider)"
          >
            <IconTrash class="w-4 h-4" />
            {{ t('delete') }}
          </button>
        </div>
      </div>
      <!-- Other orgs of the company using this provider -->
      <div
        v-if="provider.status !== 'pending_verification' && (sharedWith(provider.id).length > 0 || isOrgSuperAdmin)"
        class="flex flex-wrap items-center gap-2 px-4 py-3 text-xs border-t border-slate-200 dark:border-slate-700"
      >
        <span class="text-slate-500 dark:text-slate-400">{{ t('sso-shared-with') }}</span>
        <span
          v-for="link in sharedWith(provider.id)"
          :key="link.org_id"
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200"
        >
          {{ link.org_name }}
          <span v-if="!link.has_role_mapping" class="text-amber-600 dark:text-amber-400">({{ t('sso-shared-no-mapping-short') }})</span>
          <button
            v-if="canStopSharing(link.org_id)"
            type="button"
            class="text-slate-500 hover:text-slate-700 dark:hover:text-white"
            :aria-label="`${t('sso-stop-sharing')} ${link.org_name}`"
            @click="stopSharing(provider.id, link.org_id, provider.domain, link.org_name)"
          >
            <IconXMark class="w-3 h-3" />
          </button>
        </span>
        <span v-if="sharedWith(provider.id).length === 0" class="text-slate-400 dark:text-slate-500">{{ t('sso-shared-with-none') }}</span>
        <button
          v-if="isOrgSuperAdmin"
          type="button"
          class="ml-auto d-btn d-btn-ghost d-btn-xs text-primary"
          @click="openShareDialog(provider)"
        >
          <IconLink class="w-4 h-4" />
          {{ t('sso-share') }}
        </button>
      </div>
    </div>
  </div>

  <!-- Providers other orgs share with this org -->
  <div v-if="!isLoading && linkedProviders.length > 0" class="mt-6 space-y-3">
    <div>
      <h4 class="text-base font-semibold dark:text-white text-slate-800">
        {{ t('sso-shared-providers-title') }}
      </h4>
      <p class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('sso-shared-providers-description') }}
      </p>
    </div>
    <div
      v-for="linked in linkedProviders"
      :key="linked.provider_id"
      class="d-card d-card-bordered"
    >
      <div class="d-card-body p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-3">
            <h4 class="text-sm font-semibold truncate dark:text-white text-slate-800">
              {{ linked.domain }}
            </h4>
            <span
              class="px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap"
              :class="getStatusBadgeClass(linked.status)"
            >
              {{ getStatusLabel(linked.status) }}
            </span>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('sso-shared-by', { org: linked.owner_org_name }) }}
          </p>
          <p v-if="!linked.role_mapping" class="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {{ t('sso-shared-no-mapping') }}
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            v-if="isOrgSuperAdmin"
            type="button"
            class="d-btn d-btn-outline d-btn-sm"
            @click="roleMappingDialog?.open({ id: linked.provider_id, domain: linked.domain, role_mapping: linked.role_mapping }, { shared: true })"
          >
            {{ t('sso-role-mapping-title') }}
          </button>
          <button
            v-if="canStopSharing(linked.owner_org_id)"
            type="button"
            class="d-btn d-btn-error d-btn-outline d-btn-sm"
            @click="stopSharing(linked.provider_id, orgId, linked.domain, linked.owner_org_name)"
          >
            {{ t('sso-stop-sharing') }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === SHARE_DIALOG_ID" defer to="#dialog-v2-content">
    <div v-if="shareProviderTarget && shareCandidates(shareProviderTarget.id).length > 0" class="form-control">
      <label for="sso-share-org" class="label">
        <span class="label-text">{{ t('sso-share-org') }}</span>
      </label>
      <select
        id="sso-share-org"
        v-model="shareOrgId"
        class="d-select d-select-bordered min-h-10 w-full rounded-md bg-white text-sm text-slate-900 dark:bg-slate-900 dark:text-slate-100"
      >
        <option v-for="org in shareCandidates(shareProviderTarget.id)" :key="org.gid" :value="org.gid">
          {{ org.name }}
        </option>
      </select>
    </div>
    <p v-else class="text-sm text-slate-600 dark:text-slate-300">
      {{ t('sso-share-no-orgs') }}
    </p>
  </Teleport>

  <SsoRoleMappingDialog ref="roleMappingDialog" :org-id="orgId" @saved="onRoleMappingSaved" />
</template>
