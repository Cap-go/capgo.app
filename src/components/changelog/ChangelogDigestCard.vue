<script setup lang="ts">
import type { ChangelogDigest, ChangelogProduct, DigestContext } from '~/services/changelog'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconAlertTriangle from '~icons/lucide/alert-triangle'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheckCircle from '~icons/lucide/check-circle'
import IconClipboard from '~icons/lucide/clipboard'
import IconSparkles from '~icons/lucide/sparkles'
import ChangelogItemText from '~/components/changelog/ChangelogItemText.vue'
import ChangelogTypeBadge from '~/components/changelog/ChangelogTypeBadge.vue'
import { fetchDigest } from '~/services/changelog'

const props = defineProps<{
  product: ChangelogProduct
  repo?: string | null
  fromVersion: string
  toVersion?: string | null
  context?: DigestContext
  upgradeCommand?: string | null
  /** Modal variant: no outer card chrome, fewer highlights. */
  compact?: boolean
}>()

const emit = defineEmits<{
  loaded: [digest: ChangelogDigest | null]
}>()

const { t, locale } = useI18n()
const digest = ref<ChangelogDigest | null>(null)
const loading = ref(true)
const failed = ref(false)

const highlights = computed(() => (digest.value?.highlights ?? []).slice(0, props.compact ? 4 : 6))
const upToDate = computed(() => !!digest.value && digest.value.releaseCount === 0)
const countBadges = computed(() => {
  const counts = digest.value?.counts
  if (!counts)
    return []
  return (['security', 'removed', 'added', 'changed', 'fixed'] as const)
    .filter(type => counts[type] > 0)
    .map(type => ({ type, count: counts[type] }))
})

async function load() {
  loading.value = true
  failed.value = false
  const result = await fetchDigest({
    product: props.product,
    repo: props.repo ?? undefined,
    fromVersion: props.fromVersion,
    toVersion: props.toVersion ?? undefined,
    locale: String(locale.value),
    context: props.context,
  })
  digest.value = result
  failed.value = !result
  loading.value = false
  emit('loaded', result)
}

watch(() => [props.product, props.repo, props.fromVersion, props.toVersion, locale.value], load, { immediate: true })

async function copyCommand() {
  if (!props.upgradeCommand)
    return
  try {
    await navigator.clipboard.writeText(props.upgradeCommand)
    toast.success(t('copied-to-clipboard'))
  }
  catch {
    toast.error(t('cannot-copy'))
  }
}
</script>

<template>
  <section
    data-test="changelog-digest"
    :class="compact
      ? 'flex flex-col gap-4'
      : 'flex flex-col gap-4 rounded-xl border border-azure-500/30 bg-white p-5 shadow-sm dark:border-azure-400/30 dark:bg-slate-800/70'"
  >
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-xs font-semibold tracking-wide uppercase text-azure-600 dark:text-azure-300">
          {{ t('changelog-digest-eyebrow') }}
        </p>
        <h2 class="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
          <span class="font-mono">v{{ fromVersion }}</span>
          <IconArrowRight class="inline w-4 h-4 mx-1 -mt-0.5 text-slate-400" aria-hidden="true" />
          <span class="font-mono">v{{ digest?.toVersion ?? toVersion ?? '…' }}</span>
        </h2>
      </div>
      <span
        v-if="digest?.aiGenerated"
        class="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/30"
        :title="t('changelog-digest-ai-help')"
        data-test="changelog-digest-ai"
      >
        <IconSparkles class="w-3.5 h-3.5" aria-hidden="true" />
        {{ t('changelog-digest-ai') }}
      </span>
    </header>

    <!-- Workers AI can take a few seconds: keep the layout stable while it writes. -->
    <div v-if="loading" class="flex flex-col gap-3" aria-busy="true">
      <p class="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <IconSparkles class="w-4 h-4 animate-pulse text-violet-500" aria-hidden="true" />
        {{ t('changelog-digest-loading') }}
      </p>
      <div v-for="index in (compact ? 3 : 4)" :key="index" class="h-12 rounded-lg animate-pulse bg-slate-100 dark:bg-white/5" />
    </div>

    <p v-else-if="failed" class="text-sm text-slate-600 dark:text-slate-300">
      {{ t('changelog-digest-failed') }}
    </p>

    <div v-else-if="upToDate" class="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
      <IconCheckCircle class="w-4 h-4" aria-hidden="true" />
      {{ t('changelog-digest-up-to-date') }}
    </div>

    <template v-else-if="digest">
      <p class="text-sm leading-relaxed text-slate-700 dark:text-slate-200" data-test="changelog-digest-headline">
        {{ digest.headline }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-slate-500 dark:text-slate-400">{{ t('changelog-digest-releases', { count: digest.releaseCount }, digest.releaseCount) }}</span>
        <ChangelogTypeBadge v-for="badge in countBadges" :key="badge.type" :type="badge.type" :count="badge.count" />
      </div>

      <div
        v-if="digest.actionRequired.length"
        class="flex gap-3 p-3 border rounded-lg border-amber-200 bg-amber-50/80 dark:border-amber-800/70 dark:bg-amber-950/20"
        data-test="changelog-digest-actions"
      >
        <IconAlertTriangle class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <div class="min-w-0">
          <p class="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {{ t('changelog-digest-action-required') }}
          </p>
          <ul class="mt-1 flex flex-col gap-1 text-sm text-amber-900/90 dark:text-amber-100/90">
            <li v-for="(action, index) in digest.actionRequired" :key="index">
              <ChangelogItemText :text="action" :repo="digest.repo" />
            </li>
          </ul>
        </div>
      </div>

      <ul class="flex flex-col divide-y divide-slate-100 dark:divide-white/5">
        <li
          v-for="(highlight, index) in highlights"
          :key="index"
          class="flex gap-3 py-2.5 first:pt-0 last:pb-0"
          data-test="changelog-digest-highlight"
        >
          <div class="w-24 shrink-0 pt-0.5">
            <ChangelogTypeBadge :type="highlight.type" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-slate-900 dark:text-white">
              <ChangelogItemText :text="highlight.title" :repo="digest.repo" />
            </p>
            <p v-if="highlight.detail && !compact" class="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
              <ChangelogItemText :text="highlight.detail" :repo="digest.repo" />
            </p>
            <p class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span class="font-mono">v{{ highlight.version }}</span>
              <span
                v-if="highlight.relevant"
                class="rounded-full bg-azure-500/10 px-2 py-0.5 font-medium text-azure-700 dark:text-azure-300"
              >{{ t('changelog-digest-relevant') }}</span>
            </p>
          </div>
        </li>
      </ul>

      <div v-if="upgradeCommand" class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code class="min-w-0 flex-1 rounded-md bg-slate-100 px-3 py-2 font-mono text-sm break-all text-slate-800 dark:bg-slate-900/70 dark:text-slate-100">{{ upgradeCommand }}</code>
        <button type="button" class="d-btn d-btn-sm d-btn-outline shrink-0" @click="copyCommand">
          <IconClipboard class="w-4 h-4" aria-hidden="true" />
          {{ t('copy') }}
        </button>
      </div>
      <p v-if="digest.truncated && !compact" class="text-xs text-slate-500 dark:text-slate-400">
        {{ t('changelog-digest-truncated') }}
      </p>
    </template>
  </section>
</template>
