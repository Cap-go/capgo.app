<script setup lang="ts">
import type { ChangelogRelease } from '~/services/changelog'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconExternalLink from '~icons/lucide/external-link'
import ChangelogItemText from '~/components/changelog/ChangelogItemText.vue'
import ChangelogTypeBadge from '~/components/changelog/ChangelogTypeBadge.vue'
import { isNewerVersion } from '~/services/changelog'

const props = defineProps<{
  releases: ChangelogRelease[]
  repo: string
  query?: string
  /** The user's version: newer releases get a "new for you" marker and the divider sits under them. */
  since?: string | null
  latest?: string | null
}>()

const { t, d } = useI18n()

const rows = computed(() => props.releases.map((release, index) => {
  const isNew = !!props.since && isNewerVersion(release.version, props.since)
  const next = props.releases[index + 1]
  return {
    release,
    isNew,
    // Draw the "your version" divider once, between the last new release and the first old one.
    dividerAfter: isNew && !!next && !isNewerVersion(next.version, props.since),
  }
}))

function formatDate(date: string) {
  if (!date)
    return ''
  try {
    return d(new Date(date), { year: 'numeric', month: 'short', day: 'numeric' })
  }
  catch {
    return date.slice(0, 10)
  }
}
</script>

<template>
  <ol class="relative flex flex-col" data-test="changelog-release-list">
    <li v-for="row in rows" :key="row.release.tag" class="relative">
      <article
        :id="`v-${row.release.version}`"
        class="grid gap-3 py-5 border-b border-slate-200 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-6 dark:border-white/10"
        data-test="changelog-release"
      >
        <header class="flex flex-row flex-wrap items-center gap-2 md:sticky md:top-2 md:flex-col md:items-start md:self-start">
          <div class="flex items-center gap-2">
            <span
              v-if="row.isNew"
              class="inline-block w-2 h-2 rounded-full bg-azure-500"
              :title="t('changelog-new-for-you')"
              aria-hidden="true"
            />
            <a
              :href="`#v-${row.release.version}`"
              class="font-mono text-base font-semibold text-slate-900 hover:underline dark:text-white"
            >v{{ row.release.version }}</a>
            <span
              v-if="latest && row.release.version === latest"
              class="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
            >{{ t('changelog-latest') }}</span>
          </div>
          <time :datetime="row.release.date" class="text-xs text-slate-500 dark:text-slate-400">{{ formatDate(row.release.date) }}</time>
          <a
            v-if="row.release.url"
            :href="row.release.url"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-azure-600 dark:text-slate-400"
          >
            GitHub
            <IconExternalLink class="w-3 h-3" aria-hidden="true" />
          </a>
        </header>

        <div class="flex flex-col min-w-0 gap-4">
          <section v-for="section in row.release.sections" :key="section.type" class="flex flex-col gap-2">
            <ChangelogTypeBadge :type="section.type" class="self-start" />
            <ul class="flex flex-col gap-1.5 pl-1">
              <li
                v-for="(item, itemIndex) in section.items"
                :key="itemIndex"
                class="relative pl-4 text-sm leading-relaxed text-slate-700 before:absolute before:left-0 before:top-[0.6em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-slate-300 dark:text-slate-300 dark:before:bg-slate-600"
              >
                <ChangelogItemText :text="item" :query="query" :repo="repo" />
              </li>
            </ul>
          </section>
          <p v-if="!row.release.sections.length" class="text-sm italic text-slate-500 dark:text-slate-400">
            {{ t('changelog-no-notes') }}
          </p>
        </div>
      </article>
      <div
        v-if="row.dividerAfter"
        class="flex items-center gap-3 py-3 text-xs font-medium text-slate-500 dark:text-slate-400"
        data-test="changelog-your-version"
      >
        <span class="h-px flex-1 bg-azure-500/40" />
        {{ t('changelog-your-version', { version: since }) }}
        <span class="h-px flex-1 bg-azure-500/40" />
      </div>
    </li>
  </ol>
</template>
