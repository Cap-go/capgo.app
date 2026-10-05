<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconAlertCircle from '~icons/lucide/alert-circle'
import AuditLogTable from '~/components/tables/AuditLogTable.vue'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)
const isLoading = ref(true)

displayStore.NavTitle = t('audit-logs')

onMounted(async () => {
  await organizationStore.dedupFetchOrganizations()
  isLoading.value = false
})
</script>

<template>
  <div>
    <div v-if="currentOrganization || isLoading" class="flex flex-col h-full pb-8 overflow-hidden overflow-y-auto bg-white border shadow-sm md:p-8 md:pb-0 max-h-fit grow md:rounded-xl dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
      <div class="w-full px-4 mb-5 md:px-0">
        <h2 class="text-2xl font-bold dark:text-white text-slate-800">
          {{ t('audit-logs') }}
        </h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {{ t('audit-logs-page-description') }}
        </p>
      </div>
      <div v-if="isLoading" class="flex items-center justify-center h-64">
        <Spinner size="w-6 h-6" class="text-blue-500" />
      </div>
      <AuditLogTable v-else-if="currentOrganization" :org-id="currentOrganization.gid" />
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('no-organization-selected') }}
      </h2>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
