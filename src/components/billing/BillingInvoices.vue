<script setup lang="ts">
import type { BillingInvoice } from '~/services/stripe'
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconDownload from '~icons/heroicons/arrow-down-tray'
import { formatLocalDate } from '~/services/date'
import { formatStripeAmount, getInvoiceDocument } from '~/services/stripe'

const props = defineProps<{ orgId: string, invoices: BillingInvoice[] }>()
const { t } = useI18n()
const downloadingInvoice = ref<string | null>(null)
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

function invoiceStatusClass(status: BillingInvoice['status']) {
  if (status === 'paid')
    return 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300'
  if (status === 'open')
    return 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-200'
  return 'bg-slate-50 text-slate-600 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-300'
}

async function downloadInvoice(invoice: BillingInvoice) {
  if (downloadingInvoice.value)
    return
  const id = props.orgId
  downloadingInvoice.value = invoice.id
  try {
    const [document, { downloadInvoicePdf }] = await Promise.all([
      getInvoiceDocument(id, invoice.id),
      import('~/services/invoicePdf'),
    ])
    if (!disposed && id === props.orgId)
      await downloadInvoicePdf(document, id)
  }
  catch {
    if (!disposed)
      toast.error(t('billing-invoice-download-failed'))
  }
  finally {
    downloadingInvoice.value = null
  }
}
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-800/60" data-test="billing-invoices">
    <h2 class="border-b border-slate-100 px-5 py-4 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:border-white/10 dark:text-slate-400">
      {{ t('billing-invoices-heading') }}
    </h2>
    <p v-if="!invoices.length" class="px-5 py-6 text-sm text-slate-600 dark:text-slate-300">
      {{ t('billing-no-invoices') }}
    </p>
    <template v-else>
      <ul class="divide-y divide-slate-100 dark:divide-white/10">
        <li v-for="invoice in invoices" :key="invoice.id" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
          <span class="w-28 shrink-0 text-slate-900 dark:text-white">{{ formatLocalDate(invoice.created) }}</span>
          <button
            v-if="invoice.number"
            type="button"
            class="min-w-0 flex-1 truncate text-left text-slate-500 hover:underline dark:text-slate-400"
            :disabled="downloadingInvoice !== null"
            data-test="billing-invoice-link"
            @click="downloadInvoice(invoice)"
          >
            {{ invoice.number }}
          </button>
          <span v-else class="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">{{ invoice.id }}</span>
          <span class="w-24 text-right font-medium text-slate-900 tabular-nums dark:text-white">{{ formatStripeAmount(invoice.total, invoice.currency) }}</span>
          <span class="inline-flex w-24 justify-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset" :class="invoiceStatusClass(invoice.status)">
            {{ t(`billing-invoice-status-${invoice.status ?? 'void'}`) }}
          </span>
          <button
            v-if="invoice.number"
            type="button"
            :disabled="downloadingInvoice !== null"
            class="d-btn d-btn-ghost d-btn-xs gap-1"
            :aria-label="t('billing-download-invoice')"
            data-test="billing-download-invoice"
            @click="downloadInvoice(invoice)"
          >
            <IconDownload class="h-4 w-4" />
            PDF
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>
