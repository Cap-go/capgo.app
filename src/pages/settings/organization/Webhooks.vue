<script setup lang="ts">
import type { Webhook } from '~/stores/webhooks'
import { computedAsync } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconBeaker from '~icons/heroicons/beaker'
import IconCheck from '~icons/heroicons/check-circle'
import IconChevronDown from '~icons/heroicons/chevron-down'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconClock from '~icons/heroicons/clock'
import IconPencil from '~icons/heroicons/pencil'
import IconPlus from '~icons/heroicons/plus'
import IconTrash from '~icons/heroicons/trash'
import IconX from '~icons/heroicons/x-circle'
import Spinner from '~/components/Spinner.vue'
import WebhookDeliveryLog from '~/components/WebhookDeliveryLog.vue'
import WebhookForm from '~/components/WebhookForm.vue'
import { formatLocalDateTime } from '~/services/date'
import { checkPermissions } from '~/services/permissions'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'
import { useWebhooksStore, WEBHOOK_EVENT_TYPES } from '~/stores/webhooks'

const { t } = useI18n()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const webhooksStore = useWebhooksStore()
const dialogStore = useDialogV2Store()

displayStore.NavTitle = t('webhooks')

const { currentOrganization } = storeToRefs(organizationStore)
const { webhooks, isLoading } = storeToRefs(webhooksStore)

const showForm = ref(false)
const editingWebhook = ref<Webhook | null>(null)
const showDeliveryLog = ref(false)
const selectedWebhookForLog = ref<Webhook | null>(null)
const testingWebhookId = ref<string | null>(null)
const expandedWebhookId = ref<string | null>(null)

const canManageWebhooks = computedAsync(async () => {
  const orgId = currentOrganization.value?.gid
  if (!orgId)
    return false
  return await checkPermissions('org.update_settings', { orgId })
}, false)

onMounted(async () => {
  await organizationStore.dedupFetchOrganizations()
  await webhooksStore.fetchWebhooks()
})

watch(currentOrganization, async () => {
  await webhooksStore.fetchWebhooks()
})

function openCreateForm() {
  if (!canManageWebhooks.value) {
    toast.error(t('no-permission'))
    return
  }
  editingWebhook.value = null
  showForm.value = true
}

function openEditForm(webhook: Webhook) {
  if (!canManageWebhooks.value) {
    toast.error(t('no-permission'))
    return
  }
  editingWebhook.value = webhook
  showForm.value = true
}

async function handleFormSubmit(data: { name: string, url: string, events: string[], enabled: boolean, deliveryVersion: 'legacy' | 'standard' }) {
  if (editingWebhook.value) {
    // When editing, pass all fields including enabled
    const result = await webhooksStore.updateWebhook(editingWebhook.value.id, data)
    if (result.success) {
      toast.success(t('webhook-updated'))
      showForm.value = false
    }
    else {
      toast.error(result.error || t('webhook-update-failed'))
    }
  }
  else {
    // When creating, omit enabled (webhooks are always enabled on creation)
    const { enabled: _enabled, ...createData } = data
    const result = await webhooksStore.createWebhook(createData)
    if (result.success) {
      toast.success(t('webhook-created'))
      showForm.value = false
    }
    else {
      toast.error(result.error || t('webhook-create-failed'))
    }
  }
}

async function deleteWebhook(webhook: Webhook) {
  if (!canManageWebhooks.value) {
    toast.error(t('no-permission'))
    return
  }

  dialogStore.openDialog({
    title: t('delete-webhook'),
    description: t('delete-webhook-confirm', { name: webhook.name }),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-delete'),
        role: 'danger',
        handler: async () => {
          const result = await webhooksStore.deleteWebhook(webhook.id)
          if (result.success) {
            toast.success(t('webhook-deleted'))
          }
          else {
            toast.error(result.error || t('webhook-delete-failed'))
          }
        },
      },
    ],
  })
}

async function testWebhook(webhook: Webhook) {
  if (!canManageWebhooks.value) {
    toast.error(t('no-permission'))
    return
  }

  testingWebhookId.value = webhook.id
  const result = await webhooksStore.testWebhook(webhook.id)
  testingWebhookId.value = null

  if (result.success) {
    toast.success(t('webhook-test-success', { status: result.status, duration: result.duration_ms }))
  }
  else {
    toast.error(t('webhook-test-failed', { message: result.message }))
  }
}

async function toggleWebhook(webhook: Webhook) {
  if (!canManageWebhooks.value) {
    toast.error(t('no-permission'))
    return
  }

  const result = await webhooksStore.toggleWebhook(webhook.id)
  if (result.success) {
    // After toggle, the webhook's enabled state is now the opposite
    toast.success(!webhook.enabled ? t('webhook-enabled') : t('webhook-disabled'))
  }
  else {
    toast.error(result.error || t('webhook-toggle-failed'))
  }
}

function viewDeliveries(webhook: Webhook) {
  selectedWebhookForLog.value = webhook
  showDeliveryLog.value = true
}

function toggleExpand(webhookId: string) {
  expandedWebhookId.value = expandedWebhookId.value === webhookId ? null : webhookId
}

function getEventLabel(eventValue: string): string {
  const event = WEBHOOK_EVENT_TYPES.find(e => e.value === eventValue)
  return event?.label || eventValue
}

function formatDate(dateString: string): string {
  return formatLocalDateTime(dateString) || '-'
}

async function copySecret(secret: string) {
  try {
    await navigator.clipboard.writeText(secret)
    toast.success(t('secret-copied'))
  }
  catch {
    toast.error(t('secret-copy-failed'))
  }
}

const signatureVerificationCode = `import crypto from 'crypto'

function verifyWebhookSignature(rawBody, headers, secret) {
  const messageId = headers['webhook-id']
  const timestamp = headers['webhook-timestamp']
  const signatures = headers['webhook-signature']?.split(' ') ?? []

  // Check timestamp to prevent replay attacks (5 min tolerance)
  const currentTime = Math.floor(Date.now() / 1000)
  if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
    throw new Error('Webhook timestamp too old')
  }

  // Compute expected signature
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signaturePayload = \`\${messageId}.\${timestamp}.\${rawBody}\`
  const hmac = crypto.createHmac('sha256', secretBytes)
  hmac.update(signaturePayload)
  const expectedSignature = \`v1,\${hmac.digest('base64')}\`

  // Compare signatures (timing-safe)
  const isValid = signatures.some(signature =>
    signature.length === expectedSignature.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  )

  if (!isValid) {
    throw new Error('Invalid webhook signature')
  }

  return true
}`

const legacySignatureVerificationCode = `import crypto from 'crypto'

function verifyWebhookSignature(rawBody, headers, secret) {
  const signature = headers['x-capgo-signature'] ?? headers['X-Capgo-Signature']
  const match = signature?.match(/^v1=(\\d+)\\.([a-f0-9]{64})$/i)

  if (!match) {
    throw new Error('Invalid webhook signature format')
  }

  const [, timestamp, receivedHmac] = match

  // Check timestamp to prevent replay attacks (5 min tolerance)
  const currentTime = Math.floor(Date.now() / 1000)
  if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
    throw new Error('Webhook timestamp too old')
  }

  const signaturePayload = \`\${timestamp}.\${rawBody}\`
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(signaturePayload)
    .digest('hex')

  const isValid = receivedHmac.length === expectedHmac.length
    && crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac))

  if (!isValid) {
    throw new Error('Invalid webhook signature')
  }

  return true
}`

function getSignatureVerificationCode(webhook: Webhook) {
  return webhook.delivery_version === 'standard' ? signatureVerificationCode : legacySignatureVerificationCode
}

function getDeliveryVersionLabel(webhook: Webhook) {
  return webhook.delivery_version === 'standard' ? t('webhook-version-standard') : t('webhook-version-legacy')
}

function getWebhookDetailsId(webhookId: string) {
  return `webhook-details-${webhookId}`
}
</script>

<template>
  <div>
    <div class="flex flex-col h-full pb-8 overflow-hidden overflow-y-auto bg-white border shadow-lg md:pb-0 max-h-fit grow md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <div class="p-6 space-y-6">
        <!-- Header -->
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-2xl font-bold dark:text-white text-slate-800">
              {{ t('webhooks') }}
            </h2>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ t('webhooks-description') }}
            </p>
          </div>
          <button
            v-if="canManageWebhooks"
            class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:focus:ring-blue-800"
            @click="openCreateForm"
          >
            <IconPlus class="w-5 h-5" />
            {{ t('add-webhook') }}
          </button>
        </div>

        <!-- Loading State -->
        <div v-if="isLoading" class="flex items-center justify-center py-12">
          <Spinner size="w-8 h-8" />
        </div>

        <!-- Empty State -->
        <div
          v-else-if="webhooks.length === 0"
          class="py-12 text-center"
        >
          <div class="flex justify-center mb-4">
            <div class="p-4 bg-gray-100 rounded-full dark:bg-gray-700">
              <IconBeaker class="w-12 h-12 text-gray-400" />
            </div>
          </div>
          <h3 class="text-lg font-medium text-gray-900 dark:text-white">
            {{ t('no-webhooks') }}
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('no-webhooks-description') }}
          </p>
          <button
            v-if="canManageWebhooks"
            class="px-4 py-2 mt-4 text-sm font-medium text-blue-600 border border-blue-600 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20"
            @click="openCreateForm"
          >
            {{ t('create-first-webhook') }}
          </button>
        </div>

        <!-- Webhooks List -->
        <div v-else class="space-y-4">
          <div
            v-for="webhook in webhooks"
            :key="webhook.id"
            class="overflow-hidden border rounded-lg border-slate-200 dark:border-slate-700"
          >
            <!-- Webhook Header -->
            <button
              type="button"
              class="w-full p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset"
              :aria-expanded="expandedWebhookId === webhook.id"
              :aria-controls="getWebhookDetailsId(webhook.id)"
              @click="toggleExpand(webhook.id)"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <div
                    aria-hidden="true"
                    class="w-3 h-3 rounded-full shrink-0" :class="[
                      webhook.enabled ? 'bg-green-500' : 'bg-gray-400',
                    ]"
                  />
                  <div>
                    <h3 class="font-medium text-gray-900 dark:text-white">
                      {{ webhook.name }}
                    </h3>
                    <span class="sr-only">{{ webhook.enabled ? t('enabled') : t('disabled') }}</span>
                    <p class="max-w-xs text-sm text-gray-500 truncate dark:text-gray-400 sm:max-w-md">
                      {{ webhook.url }}
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <!-- Event badges (hidden on mobile) -->
                  <div class="hidden gap-1 sm:flex">
                    <span
                      v-for="event in webhook.events.slice(0, 2)"
                      :key="event"
                      class="px-2 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full dark:bg-blue-900/30 dark:text-blue-300"
                    >
                      {{ getEventLabel(event) }}
                    </span>
                    <span
                      v-if="webhook.events.length > 2"
                      class="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-full dark:bg-gray-700 dark:text-gray-300"
                    >
                      +{{ webhook.events.length - 2 }}
                    </span>
                  </div>
                  <IconChevronDown
                    class="w-5 h-5 text-gray-400 transition-transform" :class="[
                      expandedWebhookId === webhook.id ? 'rotate-180' : '',
                    ]"
                  />
                </div>
              </div>
            </button>

            <!-- Expanded Content -->
            <div
              v-if="expandedWebhookId === webhook.id"
              :id="getWebhookDetailsId(webhook.id)"
              class="p-4 border-t border-slate-200 dark:border-slate-700 bg-gray-50 dark:bg-gray-900/50"
            >
              <!-- Events -->
              <div class="mb-4">
                <h4 class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {{ t('subscribed-events') }}
                </h4>
                <div class="flex flex-wrap gap-2">
                  <span
                    v-for="event in webhook.events"
                    :key="event"
                    class="px-2 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full dark:bg-blue-900/30 dark:text-blue-300"
                  >
                    {{ getEventLabel(event) }}
                  </span>
                </div>
              </div>

              <!-- Signing Secret -->
              <div class="mb-4">
                <h4 class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {{ t('signing-secret') }}
                </h4>
                <div v-if="webhook.secret" class="flex items-center gap-2">
                  <code class="flex-1 px-3 py-2 font-mono text-sm text-gray-700 truncate bg-gray-100 border border-gray-200 rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300">
                    {{ webhook.secret }}
                  </code>
                  <button
                    type="button"
                    class="flex items-center justify-center text-gray-500 rounded-lg size-11 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                    :title="t('copy-secret')"
                    :aria-label="t('copy-secret')"
                    @click.stop="copySecret(webhook.secret)"
                  >
                    <IconClipboard class="w-4 h-4" />
                  </button>
                </div>
                <p v-else class="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded bg-gray-100 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300">
                  {{ t('signing-secret-unavailable') }}
                </p>
                <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {{ t('signing-secret-hint') }}
                </p>

                <!-- Signature Verification Guide -->
                <details class="mt-3">
                  <summary class="text-xs font-medium text-blue-600 cursor-pointer dark:text-blue-400 hover:underline">
                    {{ t('how-to-verify-signature') }}
                  </summary>
                  <div class="p-3 mt-2 bg-gray-100 border border-gray-200 rounded dark:bg-gray-800 dark:border-gray-700">
                    <p class="mb-2 text-xs text-gray-600 dark:text-gray-400">
                      {{ t('signature-verification-intro') }}
                    </p>
                    <ul class="mb-3 space-y-1 text-xs text-gray-600 list-disc list-inside dark:text-gray-400">
                      <template v-if="webhook.delivery_version === 'standard'">
                        <li><code class="px-1 bg-gray-200 rounded dark:bg-gray-700">webhook-signature</code>: {{ t('header-signature-desc') }}</li>
                        <li><code class="px-1 bg-gray-200 rounded dark:bg-gray-700">webhook-timestamp</code>: {{ t('header-timestamp-desc') }}</li>
                        <li><code class="px-1 bg-gray-200 rounded dark:bg-gray-700">webhook-id</code>: {{ t('header-event-id-desc') }}</li>
                      </template>
                      <template v-else>
                        <li><code class="px-1 bg-gray-200 rounded dark:bg-gray-700">X-Capgo-Signature</code>: {{ t('legacy-header-signature-desc') }}</li>
                        <li><code class="px-1 bg-gray-200 rounded dark:bg-gray-700">X-Capgo-Timestamp</code>: {{ t('header-timestamp-desc') }}</li>
                        <li><code class="px-1 bg-gray-200 rounded dark:bg-gray-700">X-Capgo-Event-ID</code>: {{ t('header-event-id-desc') }}</li>
                      </template>
                    </ul>
                    <p class="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
                      {{ t('signature-example-title') }}
                    </p>
                    <pre class="p-3 overflow-x-auto text-xs text-gray-100 bg-gray-900 rounded"><code>{{ getSignatureVerificationCode(webhook) }}</code></pre>
                  </div>
                </details>
              </div>

              <!-- Metadata -->
              <div class="mb-4 text-sm text-gray-500 dark:text-gray-400">
                <p>{{ t('webhook-delivery-version') }}: {{ getDeliveryVersionLabel(webhook) }}</p>
                <p>{{ t('created-at') }}: {{ formatDate(webhook.created_at) }}</p>
                <p>{{ t('updated-at') }}: {{ formatDate(webhook.updated_at) }}</p>
              </div>

              <!-- Actions -->
              <div class="flex flex-wrap gap-2">
                <button
                  class="flex items-center gap-1 px-3 py-1.5 min-h-11 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
                  :disabled="testingWebhookId === webhook.id"
                  @click.stop="testWebhook(webhook)"
                >
                  <Spinner v-if="testingWebhookId === webhook.id" size="w-4 h-4" />
                  <IconBeaker v-else class="w-4 h-4" />
                  {{ t('test') }}
                </button>
                <button
                  class="flex items-center gap-1 px-3 py-1.5 min-h-11 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
                  @click.stop="viewDeliveries(webhook)"
                >
                  <IconClock class="w-4 h-4" />
                  {{ t('view-deliveries') }}
                </button>
                <button
                  v-if="canManageWebhooks"
                  class="flex items-center gap-1 px-3 py-1.5 min-h-11 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
                  @click.stop="toggleWebhook(webhook)"
                >
                  <IconCheck v-if="!webhook.enabled" class="w-4 h-4" />
                  <IconX v-else class="w-4 h-4" />
                  {{ webhook.enabled ? t('disable') : t('enable') }}
                </button>
                <button
                  v-if="canManageWebhooks"
                  class="flex items-center gap-1 px-3 py-1.5 min-h-11 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
                  @click.stop="openEditForm(webhook)"
                >
                  <IconPencil class="w-4 h-4" />
                  {{ t('edit') }}
                </button>
                <button
                  v-if="canManageWebhooks"
                  class="flex items-center gap-1 px-3 py-1.5 min-h-11 text-sm font-medium text-red-600 bg-white border border-red-300 rounded-lg hover:bg-red-50 dark:bg-gray-800 dark:border-red-600 dark:hover:bg-red-900/20"
                  @click.stop="deleteWebhook(webhook)"
                >
                  <IconTrash class="w-4 h-4" />
                  {{ t('delete') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Webhook Form Modal -->
    <WebhookForm
      v-if="showForm"
      :webhook="editingWebhook"
      @submit="handleFormSubmit"
      @close="showForm = false"
    />

    <!-- Delivery Log Modal -->
    <WebhookDeliveryLog
      v-if="showDeliveryLog && selectedWebhookForLog"
      :webhook="selectedWebhookForLog"
      @close="showDeliveryLog = false"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
