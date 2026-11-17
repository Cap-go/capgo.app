<script setup lang="ts">
import { computed } from 'vue'
import { tokenizeAssistantText } from '~/utils/assistantText'
import AssistantSpans from './AssistantSpans.vue'

const props = defineProps<{ content: string }>()

const blocks = computed(() => tokenizeAssistantText(props.content))
</script>

<template>
  <div data-test="assistant-markdown">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <p
        v-if="block.type === 'heading'"
        class="my-1 font-semibold"
        :class="block.level <= 2 ? 'text-sm' : 'text-[13px]'"
      >
        <AssistantSpans :spans="block.spans" />
      </p>
      <component
        :is="block.ordered ? 'ol' : 'ul'"
        v-else-if="block.type === 'list'"
        class="my-1 space-y-0.5 pl-4"
        :class="block.ordered ? 'list-decimal' : 'list-disc'"
      >
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <AssistantSpans :spans="item" />
        </li>
      </component>
      <pre
        v-else-if="block.type === 'code'"
        class="my-1 overflow-x-auto rounded-lg bg-black/10 px-2 py-1.5 font-mono text-[12px] leading-snug whitespace-pre"
      ><span v-if="block.language" class="mb-1 block font-sans text-[10px] font-medium tracking-wide uppercase opacity-60">{{ block.language }}</span><code>{{ block.text }}</code></pre>
      <blockquote
        v-else-if="block.type === 'quote'"
        class="my-1 border-l-2 border-current/30 pl-2 whitespace-pre-wrap"
      >
        <AssistantSpans :spans="block.spans" />
      </blockquote>
      <div v-else-if="block.type === 'table'" class="my-1 overflow-x-auto">
        <table class="w-full border-collapse text-left text-xs">
          <thead>
            <tr class="border-b border-current/30">
              <th
                v-for="(cell, cellIndex) in block.headers"
                :key="cellIndex"
                scope="col"
                class="px-2 py-1 font-semibold break-words whitespace-normal"
              >
                <AssistantSpans :spans="cell" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, rowIndex) in block.rows"
              :key="rowIndex"
              class="border-b border-current/15 last:border-b-0"
            >
              <td
                v-for="(cell, cellIndex) in row"
                :key="cellIndex"
                class="px-2 py-1 align-top break-words whitespace-normal"
              >
                <AssistantSpans :spans="cell" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <img
        v-else-if="block.type === 'image'"
        :src="block.href"
        :alt="block.alt"
        class="my-1 block max-h-48 max-w-full rounded-lg"
      >
      <div v-else-if="block.type === 'rule'" class="my-2 h-px bg-current/20" role="separator" />
      <p v-else-if="block.type === 'paragraph'" class="my-1 break-words whitespace-pre-wrap">
        <AssistantSpans :spans="block.spans" />
      </p>
    </template>
  </div>
</template>
