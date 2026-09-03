<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import { getLocalConfig, isLocal } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { buildCapgoBundleUploadCommand, capgoLocalCliArgs } from '~/utils/gettingStartedCli'

const props = defineProps<{
  appId: string
}>()

const { t } = useI18n()
const dialogStore = useDialogV2Store()
const config = getLocalConfig()
const extraArgs = computed(() => capgoLocalCliArgs(config.supaHost, config.supaKey, isLocal(config.supaHost)))
const cliParts = computed(() => buildCapgoBundleUploadCommand(props.appId, extraArgs.value))

async function copyUploadCommand() {
  try {
    await navigator.clipboard.writeText(cliParts.value.command)
    toast.success(t('copied-to-clipboard'))
  }
  catch (error) {
    console.error('Failed to copy bundle upload command', error)
    dialogStore.openDialog({
      title: t('cannot-copy'),
      description: cliParts.value.command,
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
}
</script>

<template>
  <div class="mt-3 space-y-3" data-test="getting-started-live-update-panel">
    <button
      type="button"
      class="d-btn group relative h-auto min-h-0 w-full justify-start whitespace-normal rounded-2xl border-0 bg-slate-950 p-5 pr-14 text-left font-normal ring-1 ring-white/10 transition hover:bg-slate-950 hover:ring-white/20"
      data-test="getting-started-live-update-command-copy"
      :aria-label="t('getting-started-live-update-command-copy')"
      @click="copyUploadCommand"
    >
      <code class="block whitespace-pre-wrap break-all text-sm">
        <span class="text-slate-500">{{ cliParts.npx }}</span>
        <span class="text-sky-300"> {{ cliParts.pkg }}</span>
        <span class="font-bold text-violet-300">&nbsp;{{ cliParts.subcommand }}</span>
        <span class="text-emerald-300">&nbsp;{{ cliParts.appId }}</span>
        <template v-for="(arg, index) in cliParts.extraArgs" :key="`${arg}-${index}`">
          <span :class="index % 2 === 0 ? 'text-amber-300' : 'text-cyan-300'"> {{ arg }}</span>
        </template>
      </code>
      <IconCopy class="absolute right-4 top-4 h-5 w-5 text-muted-blue-300 transition group-hover:text-white" />
    </button>
    <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
      {{ t('getting-started-self-test-hint') }}
    </p>
  </div>
</template>
