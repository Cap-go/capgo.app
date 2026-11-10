<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { AdminSecurityUpdatesTrackingResponse } from '~/services/adminSecurityUpdates'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { fetchAdminSecurityUpdatesTracking } from '~/services/adminSecurityUpdates'

const { t } = useI18n()

const isLoading = ref(true)
const loadError = ref<string | null>(null)
const tracking = ref<AdminSecurityUpdatesTrackingResponse | null>(null)

async function loadTracking() {
  isLoading.value = true
  loadError.value = null
  const { data, error } = await fetchAdminSecurityUpdatesTracking()
  if (error || !data) {
    loadError.value = error?.message ?? t('admin-security-updates-load-error')
    tracking.value = null
  }
  else {
    tracking.value = data
  }
  isLoading.value = false
}

onMounted(() => {
  void loadTracking()
})
</script>

<template>
  <div
    data-testid="admin-security-updates-page"
    class="flex flex-col gap-6 p-4 pb-10 sm:p-6"
  >
    <header class="flex flex-col gap-1">
      <h1 class="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        {{ t('admin-security-updates-title') }}
      </h1>
      <p class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('admin-security-updates-description') }}
      </p>
    </header>

    <PageLoader v-if="isLoading" />
    <p
      v-else-if="loadError"
      class="d-alert d-alert-error"
      role="alert"
    >
      {{ loadError }}
    </p>

    <template v-else-if="tracking">
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <AdminStatsCard
          :title="t('admin-security-updates-opt-in-users')"
          :value="tracking.opt_in.users_opted_in"
        />
        <AdminStatsCard
          :title="t('admin-security-updates-opt-in-orgs')"
          :value="tracking.opt_in.orgs_opted_in"
        />
        <AdminStatsCard
          :title="t('admin-security-updates-opt-in-apps')"
          :value="tracking.opt_in.apps_in_opted_in_orgs"
        />
      </section>

      <section class="overflow-x-auto border rounded-lg border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
        <h2 class="px-4 py-3 text-lg font-medium border-b border-slate-200 dark:border-slate-700">
          {{ t('admin-security-updates-patches-title') }}
        </h2>
        <table class="table w-full">
          <caption class="sr-only">
            {{ t('admin-security-updates-patches-title') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ t('admin-security-updates-col-advisory-id') }}
              </th>
              <th scope="col">
                {{ t('admin-security-updates-col-package') }}
              </th>
              <th scope="col">
                {{ t('admin-security-updates-col-affected') }}
              </th>
              <th scope="col">
                {{ t('admin-security-updates-col-patched') }}
              </th>
              <th scope="col">
                {{ t('admin-security-updates-col-created') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in tracking.patches"
              :key="`${row.ghsa_id}-${row.package}-${row.affected_range}`"
            >
              <td class="font-mono text-xs">
                {{ row.ghsa_id }}
              </td>
              <td>{{ row.package }}</td>
              <td class="font-mono text-xs">
                {{ row.affected_range }}
              </td>
              <td>{{ row.patched_version ?? '-' }}</td>
              <td>{{ row.created_at }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section
        v-for="advisory in tracking.advisories"
        :key="advisory.ghsa_id"
        class="flex flex-col gap-4 p-4 border rounded-lg border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
      >
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-medium">
            {{ advisory.title }}
          </h2>
          <p class="font-mono text-xs text-slate-600 dark:text-slate-400">
            {{ advisory.ghsa_id }} · {{ advisory.severity }}
          </p>
        </div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <AdminStatsCard
            :title="t('admin-security-updates-email-sent')"
            :value="advisory.email.sent"
          />
          <AdminStatsCard
            :title="t('admin-security-updates-email-delivered')"
            :value="advisory.email.delivered"
          />
          <AdminStatsCard
            :title="t('admin-security-updates-email-opened')"
            :value="advisory.email.opened"
          />
          <AdminStatsCard
            :title="t('admin-security-updates-email-opt-outs')"
            :value="advisory.email.opt_outs"
          />
          <AdminStatsCard
            :title="t('admin-security-updates-apps-patched')"
            :value="advisory.adoption.apps_patched"
          />
          <AdminStatsCard
            :title="t('admin-security-updates-apps-vulnerable')"
            :value="advisory.adoption.apps_vulnerable"
          />
          <AdminStatsCard
            :title="t('admin-security-updates-apps-unknown')"
            :value="advisory.adoption.apps_unknown"
          />
          <AdminStatsCard
            :title="t('admin-security-updates-apps-considered')"
            :value="advisory.adoption.apps_considered"
          />
        </div>
      </section>
    </template>
  </div>
</template>
