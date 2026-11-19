<script setup lang="ts">
import type { AssistantSpan } from '~/utils/assistantText'

defineProps<{ spans: AssistantSpan[] }>()
</script>

<template>
  <template v-for="(span, index) in spans" :key="index">
    <strong v-if="span.style === 'bold'">{{ span.text }}</strong>
    <em v-else-if="span.style === 'italic'">{{ span.text }}</em>
    <span v-else-if="span.style === 'strike'" class="line-through opacity-70">{{ span.text }}</span>
    <code v-else-if="span.style === 'code'" class="rounded bg-black/10 px-1 font-mono text-[12px]">{{ span.text }}</code>
    <a
      v-else-if="span.style === 'link'"
      :href="span.href"
      target="_blank"
      rel="noopener noreferrer"
      class="underline underline-offset-2 break-all"
    >{{ span.text }}</a>
    <img
      v-else-if="span.style === 'image'"
      :src="span.href"
      :alt="span.text"
      class="my-1 block max-h-48 max-w-full rounded-lg"
    >
    <template v-else>
      {{ span.text }}
    </template>
  </template>
</template>
