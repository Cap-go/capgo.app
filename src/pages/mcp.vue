<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconClipboard from '~icons/heroicons/clipboard-document'
import McpConnectCard from '~/components/McpConnectCard.vue'
import { sendEvent } from '~/services/tracking'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

const LOCAL_MCP_COMMAND = 'npx @capgo/cli@latest mcp'
const { t } = useI18n()
const organizationStore = useOrganizationStore()
const displayStore = useDisplayStore()
displayStore.NavTitle = t('ai-assistant')

async function copyLocalCommand() {
  try {
    await navigator.clipboard.writeText(LOCAL_MCP_COMMAND)
    toast.success(t('mcp-connect-local-copied'))
  }
  catch {
    toast.error(t('copy-fail'))
    return
  }
  sendEvent({
    channel: 'console-mcp',
    event: 'MCP Connect Local Command Copied',
    org_id: organizationStore.currentOrganization?.gid,
    nonPersonTags: { placement: 'mcp_page' },
  }).catch(() => {})
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 pt-6 pb-8 sm:px-6 md:pt-8 lg:px-8">
    <div class="mx-auto flex max-w-9xl flex-col gap-4">
      <McpConnectCard />

      <div class="grid gap-4 lg:grid-cols-2">
        <section data-test="mcp-local" class="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm md:px-6 dark:border-white/10 dark:bg-slate-800/60">
          <h2 class="mb-1.5 text-base font-semibold text-slate-900 dark:text-white">
            {{ t('mcp-connect-local-title') }}
          </h2>
          <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('mcp-connect-local-description') }}
          </p>
          <button
            type="button"
            data-test="mcp-copy-local-command"
            class="d-btn mt-4 flex w-full items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition-colors hover:border-primary-500/40 hover:bg-primary-500/5 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-primary-500/50 dark:hover:bg-primary-500/10"
            :aria-label="t('mcp-connect-copy-local-command')"
            @click="copyLocalCommand"
          >
            <code class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{{ LOCAL_MCP_COMMAND }}</code>
            <span class="flex shrink-0 items-center gap-2 text-xs font-semibold text-primary-500 dark:text-slate-300">
              <IconClipboard class="h-4 w-4" aria-hidden="true" />
              {{ t('copy') }}
            </span>
          </button>
          <a href="https://capgo.app/docs/cli/reference/mcp/" target="_blank" rel="noopener noreferrer" class="mt-3 inline-block text-sm font-medium text-primary-500 hover:underline dark:text-primary-400">
            {{ t('mcp-connect-setup-guide') }}
          </a>
        </section>

        <section data-test="mcp-api-key" class="rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm md:px-6 dark:border-white/10 dark:bg-slate-800/60">
          <h2 class="mb-1.5 text-base font-semibold text-slate-900 dark:text-white">
            {{ t('mcp-connect-api-key-title') }}
          </h2>
          <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('mcp-connect-api-key-description') }}
          </p>
          <RouterLink to="/apikeys" class="d-btn d-btn-primary d-btn-sm mt-4">
            {{ t('mcp-connect-api-key-cta') }}
          </RouterLink>
        </section>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
path: /mcp
</route>
