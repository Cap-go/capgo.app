<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconInformation from '~icons/heroicons/information-circle'
import { getRoleCapabilityKeys, splitCapabilityList } from '~/services/roleCapabilities'

const props = withDefaults(defineProps<{
  roleName?: string | null
}>(), {
  roleName: '',
})

const { t, te } = useI18n()
const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const triggerId = useId()
const panelId = computed(() => `${triggerId}-panel`)

const keys = computed(() => getRoleCapabilityKeys(props.roleName))

const summary = computed(() => {
  if (!keys.value || !te(keys.value.summaryKey))
    return ''
  return t(keys.value.summaryKey)
})

const canItems = computed(() => {
  if (!keys.value || !te(keys.value.canKey))
    return []
  return splitCapabilityList(t(keys.value.canKey))
})

const cannotItems = computed(() => {
  if (!keys.value || !te(keys.value.cannotKey))
    return []
  return splitCapabilityList(t(keys.value.cannotKey))
})

const hasContent = computed(() => !!summary.value || canItems.value.length > 0 || cannotItems.value.length > 0)

onClickOutside(rootRef, () => {
  open.value = false
})

function toggle() {
  if (!hasContent.value)
    return
  open.value = !open.value
}

function close() {
  open.value = false
}
</script>

<template>
  <div
    v-if="hasContent"
    ref="rootRef"
    class="relative inline-flex shrink-0"
    data-test="role-capabilities-hint"
  >
    <button
      :id="triggerId"
      type="button"
      class="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      :aria-label="t('role-capabilities-learn-more')"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click.stop="toggle"
      @keydown.escape="close"
    >
      <IconInformation class="h-4 w-4" aria-hidden="true" />
    </button>

    <div
      v-if="open"
      :id="panelId"
      role="dialog"
      :aria-label="t('role-capabilities-learn-more')"
      class="absolute right-0 z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-md border border-slate-200 bg-white p-3 text-left text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900"
      @keydown.escape="close"
    >
      <p v-if="summary" class="leading-5 text-slate-700 dark:text-slate-200">
        {{ summary }}
      </p>

      <div
        v-if="canItems.length || cannotItems.length"
        class="mt-2 grid gap-3"
        :class="canItems.length && cannotItems.length ? 'sm:grid-cols-2' : ''"
      >
        <div v-if="canItems.length">
          <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
            {{ t('role-capabilities-can') }}
          </p>
          <ul class="space-y-1 text-slate-600 dark:text-slate-300">
            <li v-for="item in canItems" :key="`can-${item}`" class="flex gap-2 leading-5">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <div v-if="cannotItems.length">
          <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {{ t('role-capabilities-cannot') }}
          </p>
          <ul class="space-y-1 text-slate-600 dark:text-slate-300">
            <li v-for="item in cannotItems" :key="`cannot-${item}`" class="flex gap-2 leading-5">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden="true" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
