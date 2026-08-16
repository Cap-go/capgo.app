<script setup lang="ts">
import type { Webhook, WebhookDeliveryVersion } from '~/stores/webhooks'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconX from '~icons/heroicons/x-mark'
import { WEBHOOK_EVENT_TYPES } from '~/stores/webhooks'

const props = defineProps<{
  webhook: Webhook | null
}>()

const emit = defineEmits<{
  (e: 'submit', data: { name: string, url: string, events: string[], enabled: boolean, deliveryVersion: WebhookDeliveryVersion }): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const name = ref('')
const url = ref('')
const selectedEvents = ref<string[]>([])
const enabled = ref(true)
const deliveryVersion = ref<WebhookDeliveryVersion>('legacy')
const deliveryVersionConfirmed = ref(false)
const urlError = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const nameInputId = 'webhook-form-name'
const urlInputId = 'webhook-form-url'
const deliveryVersionInputId = 'webhook-form-delivery-version'
const deliveryVersionConfirmInputId = 'webhook-form-delivery-version-confirm'
const modalTitleId = 'webhook-form-title'
let previouslyFocusedElement: HTMLElement | null = null

const isEditing = computed(() => !!props.webhook)
const requiresDeliveryVersionConfirmation = computed(() => {
  return isEditing.value && props.webhook?.delivery_version !== 'standard' && deliveryVersion.value === 'standard'
})

const isValid = computed(() => {
  return (
    name.value.trim().length > 0
    && url.value.trim().length > 0
    && selectedEvents.value.length > 0
    && !urlError.value
    && (!requiresDeliveryVersionConfirmation.value || deliveryVersionConfirmed.value)
  )
})

onMounted(() => {
  previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null

  if (props.webhook) {
    name.value = props.webhook.name
    url.value = props.webhook.url
    selectedEvents.value = [...props.webhook.events]
    enabled.value = props.webhook.enabled
    deliveryVersion.value = props.webhook.delivery_version === 'standard' ? 'standard' : 'legacy'
  }

  void nextTick(() => {
    nameInput.value?.focus()
  })
})

onBeforeUnmount(() => {
  previouslyFocusedElement?.focus()
})

function validateUrl() {
  urlError.value = ''
  if (!url.value.trim()) {
    return
  }

  try {
    const parsedUrl = new URL(url.value)
    const isLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname.endsWith('.localhost')
    const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '::1'
    if (parsedUrl.protocol !== 'https:' && !isLocalhost && !isLoopback) {
      urlError.value = t('webhook-url-https-required')
    }
  }
  catch {
    urlError.value = t('webhook-url-invalid')
  }
}

function toggleEvent(eventValue: string) {
  const index = selectedEvents.value.indexOf(eventValue)
  if (index === -1) {
    selectedEvents.value.push(eventValue)
  }
  else {
    selectedEvents.value.splice(index, 1)
  }
}

function handleSubmit() {
  if (!isValid.value) {
    return
  }

  emit('submit', {
    name: name.value.trim(),
    url: url.value.trim(),
    events: selectedEvents.value,
    enabled: enabled.value,
    deliveryVersion: deliveryVersion.value,
  })
}

function handleClose() {
  emit('close')
}

function handleBackdropClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    handleClose()
  }
}

function handleDeliveryVersionChange() {
  deliveryVersionConfirmed.value = false
}
</script>

<template>
  <dialog
    open
    class="fixed inset-0 z-50 flex items-center justify-center w-full h-full max-w-none max-h-none p-4 m-0 overflow-y-auto border-0 bg-black/50"
    :aria-labelledby="modalTitleId"
    @click="handleBackdropClick"
    @keydown.esc.stop.prevent="handleClose"
  >
    <div class="flex flex-col w-full max-w-lg max-h-[90dvh] overflow-hidden bg-white rounded-lg shadow-xl dark:bg-gray-800">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-gray-200 shrink-0 dark:border-gray-700">
        <h3 :id="modalTitleId" class="text-lg font-semibold text-gray-900 dark:text-white">
          {{ isEditing ? t('edit-webhook') : t('create-webhook') }}
        </h3>
        <button
          type="button"
          class="flex items-center justify-center text-gray-400 rounded-lg size-11 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-700 dark:hover:text-white"
          :aria-label="t('close')"
          @click="handleClose"
        >
          <IconX class="w-5 h-5" />
        </button>
      </div>

      <!-- Body -->
      <div class="p-4 space-y-4 overflow-y-auto">
        <!-- Name -->
        <div>
          <label :for="nameInputId" class="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ t('webhook-name') }} <span class="text-red-500">*</span>
          </label>
          <input
            :id="nameInputId"
            ref="nameInput"
            v-model="name"
            type="text"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            :placeholder="t('webhook-name-placeholder')"
          >
        </div>

        <!-- URL -->
        <div>
          <label :for="urlInputId" class="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ t('webhook-url') }} <span class="text-red-500">*</span>
          </label>
          <input
            :id="urlInputId"
            v-model="url"
            type="url"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            :class="{ 'border-red-500': urlError }"
            :placeholder="t('webhook-url-placeholder')"
            @blur="validateUrl"
          >
          <p v-if="urlError" class="mt-1 text-sm text-red-500">
            {{ urlError }}
          </p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {{ t('webhook-url-hint') }}
          </p>
        </div>

        <!-- Delivery Version -->
        <div>
          <label :for="deliveryVersionInputId" class="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ t('webhook-delivery-version') }}
          </label>
          <select
            :id="deliveryVersionInputId"
            v-model="deliveryVersion"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            @change="handleDeliveryVersionChange"
          >
            <option value="legacy">
              {{ t('webhook-version-legacy') }}
            </option>
            <option value="standard">
              {{ t('webhook-version-standard') }}
            </option>
          </select>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {{ deliveryVersion === 'standard' ? t('webhook-version-standard-hint') : t('webhook-version-legacy-hint') }}
          </p>
          <div
            v-if="requiresDeliveryVersionConfirmation"
            class="p-3 mt-3 text-sm text-yellow-800 border border-yellow-300 rounded-lg bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-200"
          >
            <p>{{ t('webhook-version-change-warning') }}</p>
            <label :for="deliveryVersionConfirmInputId" class="flex items-start gap-2 mt-3 cursor-pointer">
              <input
                :id="deliveryVersionConfirmInputId"
                v-model="deliveryVersionConfirmed"
                type="checkbox"
                class="w-4 h-4 mt-0.5 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
              >
              <span>{{ t('webhook-version-change-confirm') }}</span>
            </label>
          </div>
        </div>

        <!-- Events -->
        <fieldset class="min-w-0 border-0 p-0">
          <legend class="block mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ t('webhook-events') }} <span class="text-red-500">*</span>
          </legend>
          <div class="space-y-2">
            <label
              v-for="event in WEBHOOK_EVENT_TYPES"
              :key="event.value"
              class="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700/50"
              :class="{
                'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-600': selectedEvents.includes(event.value),
              }"
            >
              <input
                type="checkbox"
                :checked="selectedEvents.includes(event.value)"
                class="w-4 h-4 mt-0.5 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                @change="toggleEvent(event.value)"
              >
              <div>
                <span class="font-medium text-gray-900 dark:text-white">
                  {{ event.label }}
                </span>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  {{ event.description }}
                </p>
              </div>
            </label>
          </div>
          <p v-if="selectedEvents.length === 0" class="mt-1 text-sm text-red-500">
            {{ t('webhook-events-required') }}
          </p>
        </fieldset>

        <!-- Enabled Toggle (only shown when editing) -->
        <div v-if="isEditing" class="flex items-center gap-3">
          <label class="relative inline-flex items-center cursor-pointer">
            <input
              v-model="enabled"
              type="checkbox"
              class="sr-only peer"
              :aria-label="enabled ? t('webhook-enabled') : t('webhook-disabled')"
            >
            <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600" />
          </label>
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ enabled ? t('webhook-enabled') : t('webhook-disabled') }}
          </span>
        </div>
      </div>

      <!-- Footer -->
      <div class="flex justify-end gap-3 p-4 border-t border-gray-200 shrink-0 dark:border-gray-700">
        <button
          type="button"
          class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-600"
          @click="handleClose"
        >
          {{ t('button-cancel') }}
        </button>
        <button
          type="button"
          class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:focus:ring-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!isValid"
          @click="handleSubmit"
        >
          {{ isEditing ? t('update') : t('create') }}
        </button>
      </div>
    </div>
  </dialog>
</template>
