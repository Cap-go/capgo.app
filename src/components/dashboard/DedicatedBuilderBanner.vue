<script setup lang="ts">
import type { DedicatedBuilder } from '~/services/dedicatedBuilder'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconServer from '~icons/heroicons/server-stack'
import { fetchDedicatedBuilder } from '~/services/dedicatedBuilder'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  /** When true, show even if the org already has a pending/active dedicated builder. */
  force?: boolean
}>()

const { t } = useI18n()
const router = useRouter()
const organizationStore = useOrganizationStore()

const dedicatedBuilder = ref<DedicatedBuilder | null>(null)
const loaded = ref(false)
let reqToken = 0

const visible = computed(() => {
  if (!loaded.value)
    return false
  if (props.force)
    return true
  // Teaser when they don't have a dedicated builder yet, or it's cancelled.
  return !dedicatedBuilder.value || dedicatedBuilder.value.status === 'cancelled'
})

const ctaLabel = computed(() => {
  if (dedicatedBuilder.value?.status === 'active')
    return t('dedicated-builder-banner-view')
  if (dedicatedBuilder.value?.status === 'requested' || dedicatedBuilder.value?.status === 'provisioning')
    return t('dedicated-builder-banner-view-status')
  return t('dedicated-builder-banner-cta')
})

async function load() {
  const token = ++reqToken
  loaded.value = false
  await organizationStore.awaitInitialLoad()
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId) {
    dedicatedBuilder.value = null
    loaded.value = true
    return
  }
  try {
    const row = await fetchDedicatedBuilder(orgId)
    if (token !== reqToken)
      return
    dedicatedBuilder.value = row
  }
  catch {
    if (token !== reqToken)
      return
    dedicatedBuilder.value = null
  }
  finally {
    if (token === reqToken)
      loaded.value = true
  }
}

watch(
  () => organizationStore.currentOrganization?.gid,
  () => {
    load()
  },
  { immediate: true },
)

function goToDedicatedBuilder() {
  router.push('/settings/organization/dedicated-builder')
}
</script>

<template>
  <div
    v-if="visible"
    class="flex flex-col gap-3 p-4 mb-6 border rounded-xl sm:flex-row sm:items-center sm:justify-between border-azure-200 dark:border-azure-900/50 bg-gradient-to-r from-sky-50 to-slate-50 dark:from-slate-900 dark:to-slate-800"
  >
    <div class="flex items-start gap-3">
      <div class="flex items-center justify-center w-9 h-9 rounded-lg bg-azure-500/10 text-azure-600 dark:text-azure-400 shrink-0">
        <IconServer class="w-5 h-5" />
      </div>
      <div>
        <p class="text-sm font-semibold text-slate-900 dark:text-white">
          {{ t('dedicated-builder-banner-title') }}
        </p>
        <p class="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
          {{ t('dedicated-builder-banner-desc') }}
        </p>
      </div>
    </div>
    <button
      type="button"
      class="d-btn d-btn-sm d-btn-primary shrink-0"
      @click="goToDedicatedBuilder"
    >
      {{ ctaLabel }}
    </button>
  </div>
</template>
