<script setup lang="ts">
import type { AdminABTestDistribution } from '~/services/adminABTestDistribution'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { totalABTestAssignments } from '~/services/adminABTestDistribution'
import { formatNumberValue } from '~/services/formatLocale'

const props = defineProps<{
  distribution: AdminABTestDistribution[]
}>()

const { t } = useI18n()
const totalAssignments = computed(() => totalABTestAssignments(props.distribution))

function formatPercentage(value: number) {
  return formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function branchColor(index: number) {
  return index === 0 ? 'bg-[#119eff]' : 'bg-violet-500'
}
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-gray-800">
    <header class="flex flex-col gap-2 px-6 py-5 sm:flex-row sm:items-end sm:justify-between lg:px-8 lg:py-6">
      <div>
        <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
          {{ t('admin-ab-tests') }}
        </h1>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {{ t('admin-ab-tests-description') }}
        </p>
        <p class="mt-1 text-sm tabular-nums text-slate-500 dark:text-slate-400">
          {{ t('admin-ab-tests-total', {
            tests: formatNumberValue(distribution.length),
            assignments: formatNumberValue(totalAssignments),
          }) }}
        </p>
      </div>
    </header>

    <div v-if="distribution.length === 0" class="border-t border-slate-200 px-6 py-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {{ t('admin-ab-tests-empty') }}
    </div>

    <template v-else>
      <div class="hidden grid-cols-[minmax(12rem,0.8fr)_repeat(2,minmax(0,1fr))] gap-8 border-y border-slate-200 bg-slate-50/70 px-6 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 lg:grid lg:px-8 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
        <span>{{ t('admin-ab-tests-experiment') }}</span>
        <span>{{ t('admin-ab-tests-variant') }} A</span>
        <span>{{ t('admin-ab-tests-variant') }} B</span>
      </div>

      <article
        v-for="test in distribution"
        :key="test.test_name"
        class="grid gap-x-8 gap-y-5 border-b border-slate-200 px-6 py-5 last:border-b-0 lg:grid-cols-[minmax(12rem,0.8fr)_repeat(2,minmax(0,1fr))] lg:px-8 lg:py-6 dark:border-slate-700"
      >
        <div>
          <h2 class="font-semibold text-slate-900 dark:text-white">
            {{ test.label }}
          </h2>
          <p class="mt-1 text-sm tabular-nums text-slate-500 dark:text-slate-400">
            {{ t('admin-ab-tests-assignments', { count: formatNumberValue(test.total) }) }}
          </p>
        </div>

        <div v-for="(branch, index) in test.branches" :key="branch.branch" class="min-w-0">
          <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <span class="size-2.5 shrink-0 rounded-full" :class="branchColor(index)" aria-hidden="true" />
            <span class="truncate">{{ branch.label }}</span>
          </div>
          <p class="mt-1 flex items-baseline gap-2 tabular-nums">
            <span class="text-2xl font-semibold text-slate-900 dark:text-white">{{ formatNumberValue(branch.count) }}</span>
            <span class="text-sm text-slate-500 dark:text-slate-400">({{ formatPercentage(branch.percentage) }}%)</span>
          </p>
        </div>

        <div class="flex h-2.5 overflow-hidden rounded-full bg-slate-100 lg:col-span-2 lg:col-start-2 dark:bg-slate-700">
          <div
            v-for="(branch, index) in test.branches"
            :key="branch.branch"
            role="progressbar"
            :aria-label="branch.label"
            :aria-valuenow="branch.percentage"
            aria-valuemin="0"
            aria-valuemax="100"
            class="first:border-r first:border-white/80 dark:first:border-slate-800"
            :class="branchColor(index)"
            :style="{ width: `${branch.percentage}%` }"
          />
        </div>
      </article>
    </template>
  </section>
</template>
