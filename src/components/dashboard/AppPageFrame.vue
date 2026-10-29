<script setup lang="ts">
import AppPageNotFound from '~/components/dashboard/AppPageNotFound.vue'

defineProps<{
  found: boolean
  loading: boolean
  card?: boolean
  // Drop the extra bottom margin that forces a scrollbar when the page already fits.
  flush?: boolean
}>()
</script>

<template>
  <div>
    <div v-if="found || loading">
      <div>
        <div class="mx-auto w-full max-w-9xl px-0 pt-0 sm:px-6 lg:px-8" :class="flush ? 'pb-3 md:pt-2' : 'mb-8 h-full max-h-fit overflow-y-auto md:pt-4'">
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
