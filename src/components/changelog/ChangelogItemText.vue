<script setup lang="ts">
import { computed } from 'vue'
import { githubRepoUrl, highlightParts, inlineMarkdownParts } from '~/services/changelog'

// Release notes are markdown from GitHub: render the inline subset they use
// (bold, code, issue refs) as elements instead of v-html, and mark search hits.
const props = defineProps<{
  text: string
  query?: string
  repo?: string
}>()

const parts = computed(() => inlineMarkdownParts(props.text).map(part => ({
  ...part,
  pieces: highlightParts(part.text, props.query ?? ''),
})))
</script>

<template>
  <span>
    <template v-for="(part, index) in parts" :key="index">
      <a
        v-if="part.kind === 'issue' && repo"
        :href="`${githubRepoUrl(repo)}/issues/${part.number}`"
        target="_blank"
        rel="noopener noreferrer"
        class="font-mono text-xs text-slate-500 hover:text-azure-600 hover:underline dark:text-slate-400"
      >{{ part.text }}</a>
      <component
        :is="part.kind === 'bold' ? 'strong' : part.kind === 'code' ? 'code' : 'span'"
        v-else
        :class="{
          'font-semibold text-slate-900 dark:text-white': part.kind === 'bold',
          'rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800 dark:bg-slate-900 dark:text-slate-200': part.kind === 'code',
        }"
      >
        <template v-for="(piece, pieceIndex) in part.pieces" :key="pieceIndex">
          <mark v-if="piece.match" class="rounded-sm bg-amber-200/80 px-0.5 text-inherit dark:bg-amber-400/30">{{ piece.text }}</mark>
          <template v-else>
            {{ piece.text }}
          </template>
        </template>
      </component>
    </template>
  </span>
</template>
