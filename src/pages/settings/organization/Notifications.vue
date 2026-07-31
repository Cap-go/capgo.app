<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import OrgEmailNotificationsPanel from '~/components/dashboard/OrgEmailNotificationsPanel.vue'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const displayStore = useDisplayStore()
displayStore.NavTitle = t('org-notifications')
</script>

<template>
  <div>
    <OrgEmailNotificationsPanel />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
