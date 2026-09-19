<script setup lang="ts">
import DevicesStats from '~/components/dashboard/DevicesStats.vue'
</script>

<template>
  <div class="min-h-screen bg-slate-50 px-4 py-6 dark:bg-slate-900 sm:px-6 lg:px-8">
    <DevicesStats
      app-id="com.demo.app"
      usage-kind="native"
      :use-billing-period="false"
      :accumulated="false"
      :force-demo="true"
      class="col-span-full"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
