<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import BeakerIcon from '~icons/heroicons/beaker'
import { showUploadReplicationToast } from '~/services/updateReplicationToast'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const displayStore = useDisplayStore()
const mainStore = useMainStore()

onMounted(() => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard debug')
    router.push('/dashboard')
    return
  }

  displayStore.NavTitle = t('admin-debug')
  displayStore.defaultBack = '/dashboard'
})

displayStore.NavTitle = t('admin-debug')
displayStore.defaultBack = '/dashboard'

function triggerFakeReplicationToast() {
  showUploadReplicationToast({
    eventLabel: 'Upload was uploaded',
    route: '/admin/dashboard/replication',
    actionLabel: t('view'),
    onAction: () => router.push('/admin/dashboard/replication'),
  })
}
</script>

<template>
  <main class="h-full">
    <div class="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section
        class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/80"
        aria-labelledby="replication-preview-title"
      >
        <div class="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
          <span class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-900/20 dark:text-indigo-200" aria-hidden="true">
            <BeakerIcon class="h-5 w-5" />
          </span>
          <div>
            <h1 id="replication-preview-title" class="text-xl font-semibold text-slate-900 dark:text-white">
              {{ t('admin-debug') }}
            </h1>
            <p class="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
              {{ t('admin-debug-description') }}
            </p>
          </div>
        </div>
      </section>

      <section class="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/80">
        <p id="replication-preview-hint" class="text-sm text-slate-600 dark:text-slate-300">
          {{ t('admin-debug-hint') }}
        </p>
        <button
          class="d-btn d-btn-primary mt-4"
          type="button"
          aria-describedby="replication-preview-hint"
          @click="triggerFakeReplicationToast"
        >
          {{ t('admin-debug-trigger-toast') }}
        </button>
      </section>
    </div>
  </main>
</template>
