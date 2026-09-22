<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconInformation from '~icons/heroicons/information-circle'
import { useAnchorPopover } from '~/composables/useAnchorPopover'

const props = defineProps<{
  json: string
}>()

const { t } = useI18n()
const titleId = `${useId()}-metadata-title`
const panelId = `${useId()}-metadata-panel`

const {
  isOpen,
  popoverStyle,
  finePointer,
  cancelClose,
  openPanel,
  togglePanel,
  onTriggerLeave,
} = useAnchorPopover({ defaultWidth: 448, align: 'end' })

type JsonTokenKind = 'key' | 'string' | 'number' | 'keyword' | 'punct' | 'space'
interface JsonToken { kind: JsonTokenKind, text: string }

const TOKEN_CLASS: Record<JsonTokenKind, string> = {
  key: 'text-sky-700 dark:text-sky-300',
  string: 'text-emerald-700 dark:text-emerald-300',
  number: 'text-amber-700 dark:text-amber-400',
  keyword: 'text-violet-700 dark:text-violet-300',
  punct: 'text-slate-400 dark:text-slate-500',
  space: '',
}

function tokenizeJson(source: string): JsonToken[] {
  const tokens: JsonToken[] = []
  const re = /("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([[\]{}:,])|(\s+)|./g
  for (const match of source.matchAll(re)) {
    const text = match[0]
    if (match[1] !== undefined) {
      const isKey = /^\s*:/.test(source.slice((match.index ?? 0) + text.length))
      tokens.push({ kind: isKey ? 'key' : 'string', text })
    }
    else if (match[2] !== undefined) {
      tokens.push({ kind: 'number', text })
    }
    else if (match[3] !== undefined) {
      tokens.push({ kind: 'keyword', text })
    }
    else if (match[4] !== undefined) {
      tokens.push({ kind: 'punct', text })
    }
    else {
      tokens.push({ kind: 'space', text })
    }
  }
  return tokens
}

const tokens = computed(() => tokenizeJson(props.json))
const triggerLabel = computed(() => {
  const compact = props.json.replace(/\s+/g, ' ').slice(0, 80)
  return `${t('metadata')}: ${compact}`
})

function onTriggerClick(event: MouseEvent) {
  event.stopPropagation()
  if (event.detail === 0) {
    togglePanel()
    return
  }
  if (finePointer.value) {
    if (!isOpen.value)
      void openPanel()
    return
  }
  togglePanel()
}

function onTriggerEnter() {
  if (finePointer.value)
    void openPanel()
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(props.json)
    toast.success(t('copied-to-clipboard'))
  }
  catch (error) {
    console.error(error)
    toast.error(t('copy-fail'))
  }
}
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="relative shrink-0 cursor-pointer rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-azure-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 dark:hover:bg-slate-700 dark:hover:text-azure-400"
    :aria-label="triggerLabel"
    :aria-expanded="isOpen"
    :aria-controls="panelId"
    aria-haspopup="dialog"
    data-test="log-row-metadata"
    @click="onTriggerClick"
    @mouseenter="onTriggerEnter"
    @mouseleave="onTriggerLeave"
  >
    <span
      class="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,2.75rem)] -translate-x-1/2 -translate-y-1/2"
      aria-hidden="true"
    />
    <IconInformation class="h-4 w-4" />
  </button>

  <Teleport to="body">
    <div
      v-if="isOpen"
      :id="panelId"
      ref="popoverRef"
      role="dialog"
      :aria-labelledby="titleId"
      class="fixed z-[100] flex max-h-[calc(100dvh-1.5rem)] w-[min(28rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl bg-white p-5 shadow-xl ring-1 ring-black/5 dark:bg-slate-900 dark:shadow-none dark:ring-white/10"
      :style="popoverStyle"
      data-test="log-row-metadata-popover"
      @mouseenter="cancelClose"
      @mouseleave="onTriggerLeave"
    >
      <h3 :id="titleId" class="shrink-0 text-sm font-semibold text-slate-950 dark:text-white">
        {{ t('metadata') }}
      </h3>
      <pre class="mt-3 min-h-0 min-w-0 flex-1 overflow-auto rounded-lg bg-slate-50 p-3 ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10"><code class="font-mono text-sm whitespace-pre text-slate-700 dark:text-slate-200"><span
        v-for="(token, index) in tokens"
        :key="index"
        :class="TOKEN_CLASS[token.kind]"
      >{{ token.text }}</span></code></pre>
      <button
        type="button"
        class="mt-4 inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-sm font-medium text-azure-600 hover:underline dark:text-azure-400"
        data-test="log-row-metadata-copy"
        @click="copyJson"
      >
        <IconClipboard class="h-4 w-4" aria-hidden="true" />
        {{ t('copy') }}
      </button>
    </div>
  </Teleport>
</template>
