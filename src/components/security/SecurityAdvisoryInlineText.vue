<script setup lang="ts">
import type { AdvisoryInlinePart } from '~/utils/securityAdvisoryMarkdown'

defineProps<{
  parts: AdvisoryInlinePart[]
}>()
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <strong v-if="part.kind === 'bold'">{{ part.text }}</strong>
    <code
      v-else-if="part.kind === 'code'"
      class="rounded bg-slate-100 px-1 dark:bg-slate-900"
    >{{ part.text }}</code>
    <a
      v-else-if="part.kind === 'link'"
      :href="part.href"
      class="text-azure-600 underline dark:text-azure-400"
      rel="noopener noreferrer"
      target="_blank"
    >{{ part.text }}</a>
    <span v-else>{{ part.text }}</span>
  </template>
</template>
