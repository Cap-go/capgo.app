<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCheck from '~icons/lucide/check'
import IconCopy from '~icons/lucide/copy'
import AppOnboardingAiButton from './AppOnboardingAiButton.vue'
import { builderSetupAssistants } from './onboardingDevelopmentEnvironmentOptions'

const emit = defineEmits(['copy'])
const { t } = useI18n()
const titleId = useId()
const selectedClient = ref<string>('codex')
const assistant = computed(() => builderSetupAssistants.find(option => option.client === selectedClient.value)!)
const installCommand = computed(() => `npx install-mcp 'npx @capgo/cli@latest mcp' --client ${assistant.value.client}`)
const copiedCommand = ref('')
const copyFailed = ref(false)

function selectClient(client: string) {
  selectedClient.value = client
  copyFailed.value = false
}

async function copyInstallCommand() {
  const command = installCommand.value
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(command)
    copiedCommand.value = command
    toast.success(t('copied-to-clipboard'))
  }
  catch {
    copiedCommand.value = ''
    copyFailed.value = true
  }
}
</script>

<template>
  <section class="rounded-2xl border border-azure-500/30 bg-azure-500/5 p-5 text-left dark:border-azure-400/30 dark:bg-azure-500/10" :aria-labelledby="titleId" data-test="builder-checklist-ai-setup">
    <p class="text-xs font-semibold tracking-wide text-sky-700 dark:text-azure-300">
      {{ t('builder-checklist-ai-eyebrow') }}
    </p>
    <h2 :id="titleId" class="mt-2 text-xl font-semibold leading-7 text-slate-950 dark:text-white">
      {{ t('builder-checklist-ai-title') }}
    </h2>
    <div class="mt-5 grid gap-6 lg:grid-cols-2">
      <div class="min-w-0">
        <h3 class="flex items-center gap-3 text-base font-semibold text-slate-950 dark:text-white">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-azure-500/30 text-sm text-sky-700 dark:text-azure-300" aria-hidden="true">1</span>
          {{ t('builder-checklist-mcp-install-title') }}
        </h3>
        <div class="mt-4 flex flex-wrap gap-2" role="group" :aria-label="t('builder-checklist-ai-assistants')">
          <button
            v-for="option in builderSetupAssistants"
            :key="option.client"
            type="button"
            class="d-btn h-auto min-h-11 gap-2 rounded-lg px-3 py-2 text-xs font-medium shadow-none focus-visible:ring-2 focus-visible:ring-azure-500"
            :class="selectedClient === option.client ? 'border-azure-500 bg-azure-500/10 text-sky-800 dark:text-azure-200' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-white/15 dark:bg-slate-900 dark:text-slate-200'"
            :aria-pressed="selectedClient === option.client"
            :data-test="`builder-mcp-client-${option.client}`"
            @click="selectClient(option.client)"
          >
            <img v-if="option.icon" :src="option.icon" alt="" class="h-4 w-4 object-contain dark:brightness-0 dark:invert">
            {{ option.name }}
          </button>
        </div>
        <p class="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('builder-checklist-mcp-install-description') }}
        </p>
        <div class="mt-3 overflow-hidden rounded-xl bg-slate-950 text-slate-200">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
            <span class="text-xs text-slate-400">{{ assistant.name }}</span>
            <button type="button" class="d-btn d-btn-ghost h-auto min-h-11 min-w-0 gap-2 whitespace-normal px-3 py-2 text-xs text-slate-200 hover:bg-white/10" data-test="builder-mcp-copy-install" @click="copyInstallCommand">
              <IconCheck v-if="copiedCommand === installCommand" class="h-4 w-4 shrink-0" aria-hidden="true" />
              <IconCopy v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
              {{ copiedCommand === installCommand ? t('copied-to-clipboard') : t('builder-checklist-mcp-copy') }}
            </button>
          </div>
          <pre class="whitespace-pre-wrap break-all p-4 text-sm leading-6" data-test="builder-mcp-install-command"><code>{{ installCommand }}</code></pre>
        </div>
        <p v-if="copyFailed" role="alert" class="mt-2 text-sm text-red-700 dark:text-red-300">
          {{ t('builder-checklist-mcp-copy-failed') }}
        </p>
        <p class="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {{ t('builder-checklist-mcp-restart') }}
        </p>
      </div>
      <div class="min-w-0 border-t border-azure-500/20 pt-6 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
        <h3 class="flex items-center gap-3 text-base font-semibold text-slate-950 dark:text-white">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-azure-500/30 text-sm text-sky-700 dark:text-azure-300" aria-hidden="true">2</span>
          {{ t('builder-checklist-mcp-start-title') }}
        </h3>
        <p class="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('builder-checklist-ai-description') }}
        </p>
        <AppOnboardingAiButton prominent class="mt-4" data-test="builder-checklist-copy-ai" @copy="emit('copy')">
          {{ t('builder-checklist-ai-copy') }}
        </AppOnboardingAiButton>
        <p class="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {{ t('builder-checklist-ai-human-steps') }}
        </p>
      </div>
    </div>
  </section>
</template>
