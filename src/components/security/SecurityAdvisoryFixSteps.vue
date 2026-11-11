<script setup lang="ts">
import { computed } from 'vue'
import SecurityAdvisoryInlineText from '~/components/security/SecurityAdvisoryInlineText.vue'
import { parseSecurityAdvisoryMarkdown } from '~/utils/securityAdvisoryMarkdown'

const props = defineProps<{
  markdown: string
}>()

const blocks = computed(() => parseSecurityAdvisoryMarkdown(props.markdown))
</script>

<template>
  <div
    v-if="blocks.length"
    class="space-y-2 text-sm text-slate-700 dark:text-slate-300"
    data-testid="security-advisory-fix-steps"
  >
    <template v-for="(block, index) in blocks" :key="index">
      <p v-if="block.kind === 'heading'" class="font-semibold text-slate-800 dark:text-slate-100">
        <SecurityAdvisoryInlineText :parts="block.parts" />
      </p>
      <p v-else-if="block.kind === 'paragraph'">
        <SecurityAdvisoryInlineText :parts="block.parts" />
      </p>
      <component
        :is="block.ordered ? 'ol' : 'ul'"
        v-else
        class="list-inside space-y-1"
        :class="block.ordered ? 'list-decimal' : 'list-disc'"
      >
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <SecurityAdvisoryInlineText :parts="item" />
        </li>
      </component>
    </template>
  </div>
</template>
