<script setup lang="ts">
import type { AppAdvisoryFeedResponse } from '~/services/securityUpdates'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconMail from '~icons/lucide/mail'
import IconShieldAlert from '~icons/lucide/shield-alert'
import SecurityAdvisoryMatchCard from '~/components/security/SecurityAdvisoryMatchCard.vue'
import { formatLocalDateTime } from '~/services/date'
import { fetchSecurityUpdatesFeed } from '~/services/securityUpdates'

const props = defineProps<{
  appId: string
}>()

const { t } = useI18n()

const isLoading = ref(true)
const loadError = ref<string | null>(null)
const feed = ref<AppAdvisoryFeedResponse | null>(null)

const items = computed(() => feed.value?.items ?? [])
const hasItems = computed(() => items.value.length > 0)

let loadGeneration = 0

const feedGeneratedLabel = computed(() => {
  const raw = feed.value?.feed.generated_at
  if (!raw)
    return ''
  return formatLocalDateTime(raw)
})

async function loadFeed() {
  const generation = ++loadGeneration
  if (!props.appId) {
    feed.value = null
    isLoading.value = false
    return
  }

  isLoading.value = true
  loadError.value = null
  const { data, error } = await fetchSecurityUpdatesFeed(props.appId)
  if (generation !== loadGeneration)
    return
  if (error) {
    loadError.value = t('security-updates-load-error')
    feed.value = null
  }
  else {
    feed.value = data ?? null
  }
  isLoading.value = false
}

watch(() => props.appId, () => {
  void loadFeed()
}, { immediate: true })
</script>

<template>
  <section class="space-y-6 p-4 sm:p-6" data-testid="security-updates-feed">
    <header class="space-y-2">
      <div class="flex items-center gap-2 text-slate-900 dark:text-white">
        <IconShieldAlert class="h-6 w-6 text-azure-500" aria-hidden="true" />
        <h2 class="text-2xl font-bold">
          {{ t('security-updates-title') }}
        </h2>
      </div>
      <p class="max-w-3xl text-sm text-slate-600 dark:text-slate-300">
        {{ t('security-updates-intro') }}
      </p>
    </header>

    <div v-if="isLoading" class="d-skeleton h-40 w-full rounded-xl" role="status" :aria-label="t('loading')" />

    <div
      v-else-if="loadError"
      class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-100"
      role="alert"
    >
      {{ loadError }}
    </div>

    <div v-else-if="hasItems" class="space-y-4">
      <SecurityAdvisoryMatchCard
        v-for="(item, index) in items"
        :key="`${item.package}-${item.advisory.id}-${item.affected.patched_version ?? 'none'}-${index}`"
        :item="item"
      />
      <div class="flex justify-end">
        <RouterLink
          to="/settings/account/notifications#security-updates-email"
          class="d-btn d-btn-ghost d-btn-sm gap-2"
        >
          <IconMail class="h-4 w-4" aria-hidden="true" />
          {{ t('security-updates-email-cta') }}
        </RouterLink>
      </div>
    </div>

    <div
      v-else
      class="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center dark:border-white/15 dark:bg-slate-900/40"
      data-testid="security-updates-empty"
    >
      <p class="text-sm text-slate-700 dark:text-slate-200">
        {{ t('security-updates-empty') }}
      </p>
      <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
        {{ t('security-updates-empty-unknown-versions') }}
      </p>
      <RouterLink
        to="/settings/account/notifications#security-updates-email"
        class="d-btn d-btn-outline d-btn-sm mt-4 gap-2"
      >
        <IconMail class="h-4 w-4" aria-hidden="true" />
        {{ t('security-updates-email-cta') }}
      </RouterLink>
    </div>

    <p v-if="feedGeneratedLabel" class="text-xs text-slate-500 dark:text-slate-400">
      {{ t('security-updates-feed-generated-at', { time: feedGeneratedLabel }) }}
    </p>
  </section>
</template>
