<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import AccessTable from '~/components/tables/AccessTable.vue'
import { useAppPage } from '~/composables/useAppPage'

const { t } = useI18n()
const { id, app, isLoading } = useAppPage({
  routeName: '/app/[app].settings.access',
  navTitle: t('app-access-control'),
})
</script>

<template>
  <AppPageFrame :found="!!app" :loading="isLoading">
    <AccessTable :app-id="id" />
  </AppPageFrame>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
