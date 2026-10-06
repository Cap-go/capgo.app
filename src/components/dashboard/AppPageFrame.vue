<script setup lang="ts">
import AppPageNotFound from '~/components/dashboard/AppPageNotFound.vue'

defineProps<{
  found: boolean
  loading: boolean
  card?: boolean
}>()
</script>

<template>
  <div>
    <div v-if="found || loading">
      <div>
        <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-4 lg:px-8 max-w-9xl max-h-fit">
          <div
            v-if="card"
            class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-sm md:rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10"
          >
            <slot />
          </div>
          <slot v-else />
        </div>
      </div>
    </div>
    <AppPageNotFound v-else />
  </div>
</template>
