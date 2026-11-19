<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconSparkles from '~icons/heroicons/sparkles'
import { sendEvent } from '~/services/tracking'
import { useOrganizationStore } from '~/stores/organization'

const HOSTED_MCP_URL = 'https://api.capgo.app/mcp'
const { t } = useI18n()
const organizationStore = useOrganizationStore()

async function copyHostedUrl() {
  try {
    await navigator.clipboard.writeText(HOSTED_MCP_URL)
    toast.success(t('mcp-connect-url-copied'))
  }
  catch {
    toast.error(t('copy-fail'))
    return
  }
  sendEvent({
    channel: 'console-mcp',
    event: 'MCP Connect URL Copied',
    org_id: organizationStore.currentOrganization?.gid,
  }).catch(() => {})
}
</script>

<template>
  <section
    data-test="mcp-connect-card"
    class="relative overflow-hidden rounded-xl border border-primary-500/20 bg-white px-5 py-5 shadow-sm md:px-6 dark:border-primary-500/40 dark:bg-slate-800/60"
  >
    <div class="absolute inset-y-0 left-0 w-1 bg-primary-500" />

    <div class="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
      <div class="flex min-w-0 gap-4">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-500 ring-1 ring-primary-500/15 dark:bg-primary-500/25 dark:text-slate-300 dark:ring-primary-500/30">
          <IconSparkles class="h-6 w-6" aria-hidden="true" />
        </div>
        <div class="min-w-0">
          <h2 class="mb-1.5 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            {{ t('mcp-connect-title') }}
          </h2>
          <p class="max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('mcp-connect-description') }}
          </p>
          <p class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
            <a href="https://capgo.app/docs/ai/mcp/" target="_blank" rel="noopener noreferrer" class="text-primary-500 hover:underline dark:text-primary-400">
              {{ t('mcp-connect-setup-guide') }}
            </a>
          </p>
        </div>
      </div>

      <button
        type="button"
        data-test="mcp-connect-copy-url"
        class="d-btn flex w-full shrink-0 items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition-colors hover:border-primary-500/40 hover:bg-primary-500/5 focus:ring-2 focus:ring-primary-500/30 focus:ring-offset-2 focus:outline-none lg:w-auto lg:min-w-96 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-primary-500/50 dark:hover:bg-primary-500/10"
        :aria-label="t('mcp-connect-copy-url')"
        @click="copyHostedUrl"
      >
        <code class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{{ HOSTED_MCP_URL }}</code>
        <span class="flex shrink-0 items-center gap-2 text-xs font-semibold text-primary-500 dark:text-slate-300">
          <IconClipboard class="h-4 w-4" aria-hidden="true" />
          {{ t('copy') }}
        </span>
      </button>
    </div>
  </section>
</template>
