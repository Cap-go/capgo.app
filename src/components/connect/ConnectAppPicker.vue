<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconCheck from '~icons/heroicons/check'
import IconSearch from '~icons/heroicons/magnifying-glass'

export interface ConnectApp {
  id: string
  app_id: string
  name: string | null
  /** Signed icon URL (ready to use as <img src>), or null/empty when none. */
  icon?: string | null
  /** Owning organization (UUID) — used to build per-app bindings across orgs. */
  ownerOrg: string
  /** Owning organization name — shown on the row when a key spans multiple orgs. */
  ownerOrgName?: string
}

const props = defineProps<{
  apps: ConnectApp[]
  /** Map of selected app UUID -> chosen app-level role (e.g. { uuid: 'app_admin' }). */
  modelValue: Record<string, string>
  /** Show each app's organization (when the key spans more than one org). */
  showOrg?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, string>): void
}>()

const { t } = useI18n()
const search = ref('')
const failedIcons = ref<Set<string>>(new Set())

// App-level roles the key can grant per app (app_admin is the default / recommended).
const APP_ROLES = [
  { value: 'app_admin', i18n: 'role-app-admin' },
  { value: 'app_preview', i18n: 'role-app-preview' },
  { value: 'app_developer', i18n: 'role-app-developer' },
  { value: 'app_uploader', i18n: 'role-app-uploader' },
  { value: 'app_reader', i18n: 'role-app-reader' },
] as const
const DEFAULT_ROLE = 'app_admin'

const filteredApps = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query)
    return props.apps
  return props.apps.filter(app =>
    (app.name ?? '').toLowerCase().includes(query)
    || app.app_id.toLowerCase().includes(query),
  )
})

const selectedCount = computed(() => Object.keys(props.modelValue).length)
const allSelected = computed(() => props.apps.length > 0 && selectedCount.value === props.apps.length)

function isSelected(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(props.modelValue, id)
}

function toggle(id: string): void {
  const next = { ...props.modelValue }
  if (isSelected(id))
    delete next[id]
  else
    next[id] = DEFAULT_ROLE
  emit('update:modelValue', next)
}

function setRole(id: string, role: string): void {
  emit('update:modelValue', { ...props.modelValue, [id]: role })
}

function toggleAll(): void {
  if (allSelected.value) {
    emit('update:modelValue', {})
    return
  }
  const next: Record<string, string> = { ...props.modelValue }
  for (const app of props.apps) {
    if (!isSelected(app.id))
      next[app.id] = DEFAULT_ROLE
  }
  emit('update:modelValue', next)
}

function showIcon(app: ConnectApp): boolean {
  return Boolean(app.icon) && !failedIcons.value.has(app.id)
}

function onIconError(id: string): void {
  failedIcons.value = new Set(failedIcons.value).add(id)
}
</script>

<template>
  <div>
    <div class="mb-1.5 flex items-end justify-between gap-2">
      <span class="block text-sm font-medium text-slate-700 dark:text-slate-200">
        {{ t('connect-app-access') }}
      </span>
      <button
        type="button"
        class="text-xs font-semibold text-azure-500 hover:underline"
        @click="toggleAll"
      >
        {{ allSelected ? t('connect-clear-all') : t('connect-select-all') }}
      </button>
    </div>
    <p class="mb-2 text-xs text-slate-400 dark:text-slate-500">
      {{ t('connect-app-access-hint') }}
    </p>

    <div class="rounded-2xl border border-slate-200 bg-white/70 p-2 dark:border-slate-700 dark:bg-slate-800/50">
      <div class="relative mb-2">
        <IconSearch class="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <input
          v-model="search"
          type="text"
          :aria-label="t('connect-search-apps')"
          :placeholder="t('connect-search-apps')"
          class="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 outline-none focus:border-azure-500 focus:ring-2 focus:ring-azure-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
      </div>

      <div class="max-h-64 space-y-1.5 overflow-y-auto pr-1">
        <div
          v-for="app in filteredApps"
          :key="app.id"
          class="overflow-hidden rounded-xl border transition-colors"
          :class="isSelected(app.id)
            ? 'border-azure-500 bg-azure-500/5'
            : 'border-slate-200 bg-white hover:bg-azure-500/5 dark:border-slate-700 dark:bg-slate-900'"
        >
          <button
            type="button"
            :aria-pressed="isSelected(app.id)"
            class="flex w-full items-center gap-3 px-3 py-2.5 text-left"
            @click="toggle(app.id)"
          >
            <span
              class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
              :class="isSelected(app.id)
                ? 'border-azure-500 bg-azure-500 text-white'
                : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800'"
            >
              <IconCheck v-if="isSelected(app.id)" class="h-3.5 w-3.5" />
            </span>
            <img
              v-if="showIcon(app)"
              :src="app.icon!"
              :alt="`App icon ${app.name ?? app.app_id}`"
              class="h-9 w-9 shrink-0 rounded-sm object-cover d-mask d-mask-squircle"
              @error="onIconError(app.id)"
            >
            <div
              v-else
              class="flex h-9 w-9 shrink-0 items-center justify-center bg-gray-700 text-sm font-medium text-gray-300 d-mask d-mask-squircle"
            >
              {{ (app.name ?? app.app_id).slice(0, 2).toUpperCase() || 'AP' }}
            </div>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                {{ app.name ?? app.app_id }}
              </span>
              <span class="block truncate font-mono text-xs text-slate-400">
                {{ app.app_id }}<template v-if="showOrg && app.ownerOrgName"> · {{ app.ownerOrgName }}</template>
              </span>
            </span>
          </button>

          <div v-if="isSelected(app.id)" class="border-t border-azure-500/20 px-3 py-2.5">
            <p class="mb-2 text-[0.7rem] font-semibold uppercase tracking-wider text-slate-400">
              {{ t('connect-app-role') }}
            </p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="r in APP_ROLES"
                :key="r.value"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors"
                :class="modelValue[app.id] === r.value
                  ? 'border-azure-500 bg-azure-500 text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-azure-500/50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300'"
                @click="setRole(app.id, r.value)"
              >
                {{ t(r.i18n) }}
                <span
                  v-if="r.value === 'app_admin'"
                  class="rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide"
                  :class="modelValue[app.id] === r.value ? 'bg-white/25 text-white' : 'bg-azure-500/15 text-azure-600 dark:text-azure-300'"
                >
                  {{ t('connect-recommended') }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <p v-if="filteredApps.length === 0" class="px-3 py-6 text-center text-sm text-slate-400">
          {{ t('connect-no-apps-match') }}
        </p>
      </div>
    </div>

    <p class="mt-2 text-xs text-slate-400 dark:text-slate-500">
      {{ t('connect-apps-selected', { count: selectedCount, total: apps.length }) }}
    </p>
  </div>
</template>
