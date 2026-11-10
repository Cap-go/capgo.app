<script setup lang="ts">
import type { AppAdvisoryMatch } from '~/services/securityUpdates'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconExternalLink from '~icons/lucide/external-link'
import SecurityAdvisoryFixSteps from '~/components/security/SecurityAdvisoryFixSteps.vue'
import SecurityAdvisorySeverityBadge from '~/components/security/SecurityAdvisorySeverityBadge.vue'
import { sanitizeHttpUrl } from '~/utils/sanitize'

const props = defineProps<{
  item: AppAdvisoryMatch
}>()

const { t } = useI18n()

const advisoryUrl = computed(() => sanitizeHttpUrl(props.item.advisory.url))
const plusReleaseUrl = computed(() => sanitizeHttpUrl(props.item.advisory.plus_release_url ?? ''))

const statusClass = computed(() => {
  switch (props.item.status) {
    case 'affected':
      return 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200'
    case 'patched':
      return 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200'
  }
})

const patchedVersionLabel = computed(() => {
  if (props.item.affected.patched_version)
    return props.item.affected.patched_version
  return t('security-updates-no-patched-version')
})

const showUnknownHelp = computed(() => props.item.status === 'unknown')
</script>

<template>
  <article
    class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-800/60"
    data-testid="security-advisory-match-card"
  >
    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0 space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <SecurityAdvisorySeverityBadge :severity="item.advisory.severity" />
          <span class="d-badge d-badge-sm border-0 font-medium" :class="statusClass">
            {{ t(`security-updates-status-${item.status}`) }}
          </span>
        </div>
        <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
          <a
            v-if="advisoryUrl"
            :href="advisoryUrl"
            class="inline-flex items-center gap-1 text-azure-600 hover:underline dark:text-azure-400"
            rel="noopener noreferrer"
            target="_blank"
          >
            {{ item.advisory.title }}
            <IconExternalLink class="h-4 w-4 shrink-0" aria-hidden="true" />
            <span class="sr-only">{{ t('open-in-new-tab') }}</span>
          </a>
          <span v-else>{{ item.advisory.title }}</span>
        </h3>
        <dl class="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-slate-500 dark:text-slate-400">
              {{ t('security-updates-package') }}
            </dt>
            <dd class="font-mono text-slate-900 dark:text-slate-100">
              {{ item.package }}
            </dd>
          </div>
          <div>
            <dt class="text-slate-500 dark:text-slate-400">
              {{ t('security-updates-reported-version') }}
            </dt>
            <dd class="font-mono text-slate-900 dark:text-slate-100">
              {{ item.current_version || t('security-updates-version-missing') }}
            </dd>
          </div>
          <div>
            <dt class="text-slate-500 dark:text-slate-400">
              {{ t('security-updates-patched-version-label') }}
            </dt>
            <dd class="font-mono text-slate-900 dark:text-slate-100">
              {{ patchedVersionLabel }}
            </dd>
          </div>
          <div v-if="plusReleaseUrl">
            <dt class="text-slate-500 dark:text-slate-400">
              {{ t('security-updates-capacitor-plus-release') }}
            </dt>
            <dd>
              <a
                :href="plusReleaseUrl"
                class="text-azure-600 hover:underline dark:text-azure-400"
                rel="noopener noreferrer"
                target="_blank"
              >
                {{ t('security-updates-view-release') }}
              </a>
            </dd>
          </div>
        </dl>
        <p v-if="showUnknownHelp" class="text-sm text-slate-600 dark:text-slate-300">
          {{ t('security-updates-unknown-status-help') }}
        </p>
      </div>
    </div>
    <div class="mt-4 border-t border-slate-200 pt-4 dark:border-white/10">
      <h4 class="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
        {{ t('security-updates-fix-steps') }}
      </h4>
      <SecurityAdvisoryFixSteps :markdown="item.advisory.fix_steps" />
    </div>
  </article>
</template>
