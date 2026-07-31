<script setup lang="ts">
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import AppSetting from '~/components/dashboard/AppSetting.vue'
import { useAppPage } from '~/composables/useAppPage'

const { id, app, isLoading } = useAppPage({ routeName: '/app/[app].settings' })
</script>

<template>
  <AppPageFrame card :found="!!app" :loading="isLoading">
    <AppSetting :app-id="id" />
  </AppPageFrame>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
