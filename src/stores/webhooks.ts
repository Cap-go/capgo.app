import type { Ref } from 'vue'
import type { Database } from '~/types/supabase.types'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { errorMessage } from '~/utils/errors'
import { useOrganizationStore } from './organization'

export interface DeliveryPagination {
  page: number
  per_page: number
  total: number
  has_more: boolean
}

export interface TestResult {
  success: boolean
  status: number | null
  duration_ms: number | null
  response_preview: string | null
  delivery_id: string
  message: string
}

export type Webhook = Omit<Database['public']['Tables']['webhooks']['Row'], 'secret'> & {
  secret?: string
}

export type WebhookDeliveryVersion = 'legacy' | 'standard'

// Supported event types
export const WEBHOOK_EVENT_TYPES = [
  { value: 'apps', label: 'App Changes', description: 'When apps are created, updated, or deleted' },
  { value: 'app_versions', label: 'Bundle Changes', description: 'When bundles are created, updated, or deleted' },
  { value: 'channels', label: 'Channel Updates', description: 'When channels are modified' },
  { value: 'org_users', label: 'Member Changes', description: 'When members are added or removed' },
  { value: 'orgs', label: 'Organization Changes', description: 'When organization settings are updated' },
] as const

function buildWebhookFunctionPath(path: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined)
      query.set(key, String(value))
  })

  const queryString = query.toString()
  return queryString ? `${path}?${queryString}` : path
}

function getFunctionErrorMessage(error: unknown, fallback: string) {
  return errorMessage(error, fallback)
}

const VALID_WEBHOOK_EVENT_VALUES = new Set<string>(WEBHOOK_EVENT_TYPES.map(e => e.value))

export const useWebhooksStore = defineStore('webhooks', () => {
  const webhooks: Ref<Webhook[]> = ref([])
  const deliveries: Ref<Database['public']['Tables']['webhook_deliveries']['Row'][]> = ref([])
  const deliveryPagination: Ref<DeliveryPagination | null> = ref(null)
  const isLoading = ref(false)
  const isLoadingDeliveries = ref(false)

  /**
   * Fetch all webhooks for the current organization
   * Uses the webhook API so secrets and delivery data never go through direct table access.
   */
  async function fetchWebhooks(): Promise<void> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      console.error('No organization selected')
      return
    }

    isLoading.value = true
    try {
      const { data, error } = await invokeCapgoApi(buildWebhookFunctionPath('webhooks', { orgId }), {
        method: 'GET',
      })

      if (error) {
        console.error('Failed to fetch webhooks:', error)
        return
      }

      webhooks.value = Array.isArray(data) ? data : []
    }
    catch (err) {
      console.error('Error fetching webhooks:', err)
    }
    finally {
      isLoading.value = false
    }
  }

  /**
   * Get a single webhook
   * Uses the webhook API so secrets and delivery data never go through direct table access.
   */
  async function getWebhook(webhookId: string): Promise<Webhook | null> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      console.error('No organization selected')
      return null
    }

    try {
      const { data, error } = await invokeCapgoApi(buildWebhookFunctionPath('webhooks', { orgId, webhookId }), {
        method: 'GET',
      })

      if (error) {
        console.error('Failed to fetch webhook:', error)
        return null
      }

      return data
    }
    catch (err) {
      console.error('Error fetching webhook:', err)
      return null
    }
  }

  /**
   * Create a new webhook
   * Uses the webhook API so secrets and delivery data never go through direct table access.
   */
  async function createWebhook(webhookData: {
    name: string
    url: string
    events: string[]
    deliveryVersion?: WebhookDeliveryVersion
  }): Promise<{ success: boolean, webhook?: Webhook, error?: string }> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      return { success: false, error: 'No organization selected' }
    }

    // Validate URL is HTTPS (except localhost for testing)
    try {
      const parsedUrl = new URL(webhookData.url)
      const isLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname.endsWith('.localhost')
      const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '::1'
      if (parsedUrl.protocol !== 'https:' && !isLocalhost && !isLoopback) {
        return { success: false, error: 'Webhook URL must use HTTPS' }
      }
    }
    catch {
      return { success: false, error: 'Invalid URL' }
    }

    // Validate events
    const invalidEvents = webhookData.events.filter(e => !VALID_WEBHOOK_EVENT_VALUES.has(e))
    if (invalidEvents.length > 0) {
      return { success: false, error: `Invalid event types: ${invalidEvents.join(', ')}` }
    }

    try {
      const { data, error } = await invokeCapgoApi('webhooks', {
        method: 'POST',
        body: {
          orgId,
          name: webhookData.name,
          url: webhookData.url,
          events: webhookData.events,
          enabled: true,
          deliveryVersion: webhookData.deliveryVersion ?? 'legacy',
        },
      })

      if (error) {
        return { success: false, error: getFunctionErrorMessage(error, 'Failed to create webhook') }
      }

      // Add to local list
      if (data?.webhook) {
        webhooks.value.unshift(data.webhook)
      }

      return { success: true, webhook: data?.webhook }
    }
    catch (err: unknown) {
      return { success: false, error: errorMessage(err, 'Error creating webhook') }
    }
  }

  /**
   * Update an existing webhook
   * Uses the webhook API so secrets and delivery data never go through direct table access.
   */
  async function updateWebhook(
    webhookId: string,
    webhookData: Partial<{
      name: string
      url: string
      events: string[]
      enabled: boolean
      deliveryVersion: WebhookDeliveryVersion
    }>,
  ): Promise<{ success: boolean, webhook?: Webhook, error?: string }> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      return { success: false, error: 'No organization selected' }
    }

    // Validate URL if provided
    if (webhookData.url) {
      try {
        const parsedUrl = new URL(webhookData.url)
        const isLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname.endsWith('.localhost')
        const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '::1'
        if (parsedUrl.protocol !== 'https:' && !isLocalhost && !isLoopback) {
          return { success: false, error: 'Webhook URL must use HTTPS' }
        }
      }
      catch {
        return { success: false, error: 'Invalid URL' }
      }
    }

    // Validate events if provided
    if (webhookData.events) {
      const invalidEvents = webhookData.events.filter(e => !VALID_WEBHOOK_EVENT_VALUES.has(e))
      if (invalidEvents.length > 0) {
        return { success: false, error: `Invalid event types: ${invalidEvents.join(', ')}` }
      }
    }

    try {
      const { data, error } = await invokeCapgoApi('webhooks', {
        method: 'PUT',
        body: {
          orgId,
          webhookId,
          ...webhookData,
        },
      })

      if (error) {
        return { success: false, error: getFunctionErrorMessage(error, 'Failed to update webhook') }
      }

      // Update local list
      if (data?.webhook) {
        const index = webhooks.value.findIndex(w => w.id === webhookId)
        if (index !== -1) {
          webhooks.value[index] = data.webhook
        }
      }

      return { success: true, webhook: data?.webhook }
    }
    catch (err: unknown) {
      return { success: false, error: errorMessage(err, 'Error updating webhook') }
    }
  }

  /**
   * Delete a webhook
   * Uses the webhook API so secrets and delivery data never go through direct table access.
   */
  async function deleteWebhook(webhookId: string): Promise<{ success: boolean, error?: string }> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      return { success: false, error: 'No organization selected' }
    }

    try {
      const { error } = await invokeCapgoApi('webhooks', {
        method: 'DELETE',
        body: { orgId, webhookId },
      })

      if (error) {
        return { success: false, error: getFunctionErrorMessage(error, 'Failed to delete webhook') }
      }

      // Remove from local list
      webhooks.value = webhooks.value.filter(w => w.id !== webhookId)

      return { success: true }
    }
    catch (err: unknown) {
      return { success: false, error: errorMessage(err, 'Error deleting webhook') }
    }
  }

  /**
   * Test a webhook - requires edge function to make actual HTTP call
   */
  async function testWebhook(webhookId: string): Promise<TestResult> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      return {
        success: false,
        status: null,
        duration_ms: null,
        response_preview: null,
        delivery_id: '',
        message: 'No organization selected',
      }
    }

    try {
      const { data, error } = await invokeCapgoApi('webhooks/test', {
        method: 'POST',
        body: { orgId, webhookId },
      })

      if (error) {
        return {
          success: false,
          status: null,
          duration_ms: null,
          response_preview: null,
          delivery_id: '',
          message: getFunctionErrorMessage(error, 'Failed to test webhook'),
        }
      }

      return data
    }
    catch (err: unknown) {
      return {
        success: false,
        status: null,
        duration_ms: null,
        response_preview: null,
        delivery_id: '',
        message: errorMessage(err, 'Error testing webhook'),
      }
    }
  }

  /**
   * Fetch deliveries for a webhook
   * Uses the webhook API so secrets and delivery data never go through direct table access.
   */
  async function fetchDeliveries(webhookId: string, page = 0, status?: string): Promise<void> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      console.error('No organization selected')
      return
    }

    isLoadingDeliveries.value = true
    try {
      const { data, error } = await invokeCapgoApi(buildWebhookFunctionPath('webhooks/deliveries', {
        orgId,
        webhookId,
        page,
        status,
      }), {
        method: 'GET',
      })

      if (error) {
        console.error('Failed to fetch deliveries:', error)
        return
      }

      deliveries.value = data?.deliveries || []
      deliveryPagination.value = data?.pagination || null
    }
    catch (err) {
      console.error('Error fetching deliveries:', err)
    }
    finally {
      isLoadingDeliveries.value = false
    }
  }

  /**
   * Retry a failed delivery - requires edge function to queue the retry
   */
  async function retryDelivery(deliveryId: string): Promise<{ success: boolean, error?: string }> {
    const organizationStore = useOrganizationStore()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      return { success: false, error: 'No organization selected' }
    }

    try {
      const { error } = await invokeCapgoApi('webhooks/deliveries/retry', {
        method: 'POST',
        body: { orgId, deliveryId },
      })

      if (error) {
        return { success: false, error: getFunctionErrorMessage(error, 'Failed to retry delivery') }
      }

      // Update local delivery status
      const index = deliveries.value.findIndex(d => d.id === deliveryId)
      if (index !== -1) {
        deliveries.value[index].status = 'pending'
        deliveries.value[index].attempt_count = 0
      }

      return { success: true }
    }
    catch (err: unknown) {
      return { success: false, error: errorMessage(err, 'Error retrying delivery') }
    }
  }

  /**
   * Toggle webhook enabled state
   */
  async function toggleWebhook(webhookId: string): Promise<{ success: boolean, error?: string }> {
    const webhook = webhooks.value.find(w => w.id === webhookId)
    if (!webhook) {
      return { success: false, error: 'Webhook not found' }
    }

    return updateWebhook(webhookId, { enabled: !webhook.enabled })
  }

  /**
   * Clear store state
   */
  function reset(): void {
    webhooks.value = []
    deliveries.value = []
    deliveryPagination.value = null
    isLoading.value = false
    isLoadingDeliveries.value = false
  }

  return {
    // State
    webhooks,
    deliveries,
    deliveryPagination,
    isLoading,
    isLoadingDeliveries,

    // Actions
    fetchWebhooks,
    getWebhook,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    testWebhook,
    fetchDeliveries,
    retryDelivery,
    toggleWebhook,
    reset,
  }
})
