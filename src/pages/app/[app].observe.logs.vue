<script setup lang="ts">
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import LogTable from '~/components/tables/LogTable.vue'
import { useAppPage } from '~/composables/useAppPage'

const { id, app, isLoading } = useAppPage({ routeName: '/app/[app].observe.logs' })
</script>

<template>
  <AppPageFrame card :found="!!app" :loading="isLoading">
    <LogTable :app-id="id" />
  </AppPageFrame>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
