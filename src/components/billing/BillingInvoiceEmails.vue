<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { checkPermissions } from '~/services/permissions'
import { getInvoiceEmailPreferences, updateInvoiceEmailPreferences } from '~/services/stripe'
import { invoiceEmailPreferencesSchema } from '../../../supabase/functions/shared/invoice-email'

const props = defineProps<{ orgId: string }>()
const emit = defineEmits<{ denied: [] }>()
const { t } = useI18n()
const enabled = ref(true)
const recipients = ref('')
const defaultEmail = ref('')
const loading = ref(true)
const loadFailed = ref(false)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const result = await getInvoiceEmailPreferences(props.orgId)
    if (disposed)
      return
    enabled.value = result.enabled
    recipients.value = result.recipients.join('\n')
    defaultEmail.value = result.defaultEmail
  }
  catch {
    if (!disposed)
      loadFailed.value = true
  }
  finally {
    loading.value = false
  }
}
onMounted(load)

async function save() {
  if (saving.value)
    return
  saved.value = false
  error.value = ''
  const parsed = invoiceEmailPreferencesSchema.safeParse({ enabled: enabled.value, recipients: recipients.value.split(/[\n,;]+/).map(value => value.trim()).filter(Boolean) })
  if (!parsed.success) {
    error.value = t('invoice-emails-invalid')
    return
  }
  saving.value = true
  try {
    if (!await checkPermissions('org.update_billing', { orgId: props.orgId })) {
      if (!disposed)
        emit('denied')
      return
    }
    if (disposed)
      return
    await updateInvoiceEmailPreferences(props.orgId, parsed.data)
    if (!disposed)
      saved.value = true
  }
  catch {
    if (!disposed)
      error.value = t('invoice-emails-save-error')
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="invoice-emails">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {{ t('invoice-emails-heading') }}
    </h2>
    <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
      {{ t('invoice-emails-description') }}
    </p>
    <output v-if="loading" class="block py-5" :aria-label="t('loading')">
      <span class="d-loading d-loading-spinner d-loading-sm" />
    </output>
    <div v-else-if="loadFailed" class="mt-4" role="alert">
      <p>{{ t('invoice-emails-load-error') }}</p>
      <button type="button" class="d-btn d-btn-sm d-btn-outline mt-2" @click="load">
        {{ t('retry') }}
      </button>
    </div>
    <form v-else class="mt-4 space-y-4" @submit.prevent="save" @input="saved = false">
      <label class="flex items-center gap-3 text-sm">
        <input v-model="enabled" name="invoiceEmailsEnabled" type="checkbox" class="d-toggle d-toggle-primary" :disabled="saving">
        {{ t('invoice-emails-enabled') }}
      </label>
      <label class="block text-sm">
        {{ t('invoice-emails-recipients') }}
        <textarea v-model="recipients" name="invoiceEmailRecipients" rows="3" maxlength="1280" :placeholder="defaultEmail" :disabled="saving" class="d-textarea d-textarea-bordered mt-2 w-full" aria-describedby="invoice-email-help" />
      </label>
      <p id="invoice-email-help" class="text-sm text-slate-500 dark:text-slate-400">
        {{ t('invoice-emails-help', { email: defaultEmail }) }}
      </p>
      <p v-if="error" role="alert" class="text-sm text-red-600 dark:text-red-300">
        {{ error }}
      </p>
      <p v-if="saved" role="status" class="text-sm text-green-700 dark:text-green-300">
        {{ t('invoice-emails-saved') }}
      </p>
      <button type="submit" class="d-btn d-btn-sm d-btn-primary" :disabled="saving">
        <span v-if="saving" class="d-loading d-loading-spinner d-loading-xs" />
        {{ t('invoice-emails-save') }}
      </button>
    </form>
  </section>
</template>
