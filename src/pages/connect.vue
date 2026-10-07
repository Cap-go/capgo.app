<script setup lang="ts">
import type { ConnectApp } from '~/components/connect/ConnectAppPicker.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconArrowLeft from '~icons/heroicons/arrow-left-20-solid'
import IconCheck from '~icons/heroicons/check'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconKey from '~icons/heroicons/key'
import IconLock from '~icons/heroicons/lock-closed'
import ConnectAppPicker from '~/components/connect/ConnectAppPicker.vue'
import { createAiApiKey } from '~/services/apikeys'
import { createSignedImageUrl, resolveImagePath } from '~/services/storage'
import { useSupabase } from '~/services/supabase'
import { isAdminRole, useOrganizationStore } from '~/stores/organization'

type Role = 'admin' | 'member'

const { t } = useI18n()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()

const tokenName = ref(t('connect-token-name-default'))
const role = ref<Role>('member')
const apps = ref<ConnectApp[]>([])
const selectedApps = ref<Record<string, string>>({})
const selectedOrgIds = ref<string[]>([])
const isLoadingApps = ref(false)
const isGenerating = ref(false)
const generatedKey = ref<string | null>(null)

// Admin: also allow the key to create new organizations (org.create global permission).
const allowOrgCreate = ref(false)

// Only orgs where the user can actually mint a key (key creation requires org admin).
const orgs = computed(() =>
  organizationStore.organizations
    .filter(o => isAdminRole(o.role))
    .map(o => ({ gid: o.gid, name: o.name, logo: o.logo, logo_is_loading: o.logo_is_loading })),
)

// Two-letter org acronym fallback — same as the org switcher (DropdownOrganization).
function acronym(name: string): string {
  const trimmed = name.trim()
  if (!trimmed)
    return '?'
  const parts = trimmed.split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : (parts[0]?.[1] ?? '')
  return (first + second).toUpperCase()
}

const selectedOrgNames = computed(() =>
  orgs.value.filter(o => selectedOrgIds.value.includes(o.gid)).map(o => o.name),
)
const allOrgsSelected = computed(() => orgs.value.length > 0 && selectedOrgIds.value.length === orgs.value.length)

const pasteLine = computed(() => t('connect-paste-line', { key: generatedKey.value ?? '' }))

const scopeChip = computed(() => {
  if (role.value === 'admin')
    return t('connect-scope-admin')
  return t('connect-scope-member', { count: Object.keys(selectedApps.value).length })
})

const canGenerate = computed(() => {
  if (selectedOrgIds.value.length === 0 || isGenerating.value || isLoadingApps.value)
    return false
  if (role.value === 'member' && Object.keys(selectedApps.value).length === 0)
    return false
  return true
})

function isOrgSelected(gid: string): boolean {
  return selectedOrgIds.value.includes(gid)
}

function toggleOrg(gid: string): void {
  const next = new Set(selectedOrgIds.value)
  if (next.has(gid))
    next.delete(gid)
  else
    next.add(gid)
  selectedOrgIds.value = [...next]
}

function toggleAllOrgs(): void {
  selectedOrgIds.value = allOrgsSelected.value ? [] : orgs.value.map(o => o.gid)
}

let appLoadRun = 0

async function loadApps(orgIds: string[]): Promise<void> {
  const run = ++appLoadRun
  if (orgIds.length === 0) {
    apps.value = []
    selectedApps.value = {}
    return
  }
  isLoadingApps.value = true
  try {
    const { data, error } = await supabase
      .from('apps')
      .select('id, app_id, name, owner_org, icon_url')
      .in('owner_org', orgIds)
      .order('name', { ascending: true })

    if (error)
      throw error
    if (run !== appLoadRun)
      return

    const orgNameById = new Map(orgs.value.map(o => [o.gid, o.name]))
    const list: ConnectApp[] = (data ?? [])
      .filter((app): app is typeof app & { id: string } => typeof app.id === 'string')
      .map(app => ({
        id: app.id,
        app_id: app.app_id,
        name: app.name,
        icon: null,
        ownerOrg: app.owner_org,
        ownerOrgName: orgNameById.get(app.owner_org) ?? undefined,
      }))
    apps.value = list

    // Drop selections for apps no longer listed (e.g. an org was deselected).
    const ids = new Set(list.map(a => a.id))
    selectedApps.value = Object.fromEntries(
      Object.entries(selectedApps.value).filter(([id]) => ids.has(id)),
    )

    // App icons live in a private bucket — sign them, then patch into the rows.
    void signIcons(data ?? [], run)
  }
  catch {
    if (run === appLoadRun) {
      apps.value = []
      toast.error(t('connect-generate-error'))
    }
  }
  finally {
    if (run === appLoadRun)
      isLoadingApps.value = false
  }
}

async function signIcons(rows: Array<{ id: string | null, icon_url?: string | null }>, run: number): Promise<void> {
  await Promise.all(rows.map(async (row) => {
    if (!row.id)
      return
    const { normalized, shouldSign } = resolveImagePath(row.icon_url)
    let url = shouldSign ? '' : normalized
    if (shouldSign) {
      try {
        url = (await createSignedImageUrl(row.icon_url)) || ''
      }
      catch {
        url = ''
      }
    }
    if (run !== appLoadRun || !url)
      return
    const idx = apps.value.findIndex(a => a.id === row.id)
    if (idx >= 0)
      apps.value[idx] = { ...apps.value[idx], icon: url }
  }))
}

onMounted(() => {
  organizationStore.dedupFetchOrganizations().catch(() => {})
  // Populate signed org logos (org.logo) — same source the org switcher uses.
  organizationStore.refreshOrganizationLogos().catch(() => {})
})

// No org is selected by default — the user picks which orgs the key spans.
watch(selectedOrgIds, (ids) => {
  loadApps(ids)
}, { deep: true })

async function generate(): Promise<void> {
  if (!canGenerate.value)
    return

  isGenerating.value = true
  try {
    const appById = new Map(apps.value.map(a => [a.id, a]))
    const chosenApps = role.value === 'member'
      ? Object.entries(selectedApps.value)
          .filter(([id]) => appById.has(id))
          .map(([id, appRole]) => ({ uuid: id, orgId: appById.get(id)!.ownerOrg, role: appRole }))
      : undefined

    const { data, error } = await createAiApiKey(supabase, tokenName.value.trim() || t('connect-token-name-default'), {
      orgIds: [...selectedOrgIds.value],
      role: role.value,
      apps: chosenApps,
      allowOrgCreate: allowOrgCreate.value,
    })

    if (error)
      throw error

    const key = typeof data?.key === 'string' ? data.key : null
    if (!key)
      throw new Error('missing key')

    generatedKey.value = key
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  catch (e) {
    // Surface actionable backend errors (e.g. a forbidden binding for a non-admin)
    // instead of a blind generic toast; log for diagnostics, keep a generic fallback.
    console.error('createAiApiKey failed', e)
    let detail = ''
    try {
      const ctx = (e as { context?: { json?: () => Promise<{ error?: string, message?: string }> } }).context
      if (ctx?.json) {
        const body = await ctx.json()
        detail = body?.error ?? body?.message ?? ''
      }
      else if (e instanceof Error && e.message && e.message !== 'missing key') {
        detail = e.message
      }
    }
    catch {
      // response body wasn't JSON / unreadable — fall back to the generic message
    }
    toast.error(detail ? `${t('connect-generate-error')}: ${detail}` : t('connect-generate-error'))
  }
  finally {
    isGenerating.value = false
  }
}

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(t('connect-copied'))
  }
  catch {
    toast.error(t('copy-fail'))
  }
}

function back(): void {
  generatedKey.value = null
}
</script>

<template>
  <div class="h-full w-full overflow-y-auto bg-slate-100 dark:bg-slate-900">
    <div class="mx-auto flex w-full max-w-xl flex-col px-4 py-8 sm:px-6">
      <!-- Header -->
      <div class="mb-5 flex items-center gap-3">
        <span class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <IconKey class="h-5 w-5 text-primary" />
        </span>
        <div class="min-w-0">
          <p class="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-slate-500">
            Capgo
          </p>
          <p class="mt-0.5 truncate text-sm font-medium text-slate-600 dark:text-slate-300">
            {{ t('connect-subtitle') }}
          </p>
        </div>
      </div>

      <!-- ============ GENERATE VIEW ============ -->
      <div
        v-if="!generatedKey"
        class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-7"
      >
        <div>
          <p class="text-[0.72rem] font-bold uppercase tracking-[0.22em] text-slate-500">
            {{ t('connect-key-label') }}
          </p>
          <h2 class="mt-2 text-2xl font-semibold leading-tight text-slate-950 dark:text-white">
            {{ t('connect-title') }}
          </h2>
          <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            {{ t('connect-intro') }}
          </p>
        </div>

        <div class="mt-6 space-y-5">
          <!-- Token name -->
          <div>
            <label for="connect-token-name-input" class="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ t('connect-token-name') }}
            </label>
            <input
              id="connect-token-name-input"
              v-model="tokenName"
              type="text"
              class="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none focus:border-azure-500 focus:ring-2 focus:ring-azure-500/25 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
          </div>

          <!-- Organizations (multi-select) -->
          <div>
            <div class="mb-1.5 flex items-end justify-between gap-2">
              <span class="block text-sm font-medium text-slate-700 dark:text-slate-200">
                {{ t('connect-organization') }}
              </span>
              <button
                v-if="orgs.length > 1"
                type="button"
                class="text-xs font-semibold text-azure-500 hover:underline"
                @click="toggleAllOrgs"
              >
                {{ allOrgsSelected ? t('connect-clear-all') : t('connect-select-all') }}
              </button>
            </div>
            <div class="rounded-2xl border border-slate-200 bg-white/70 p-2 dark:border-slate-700 dark:bg-slate-800/50">
              <div class="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                <button
                  v-for="org in orgs"
                  :key="org.gid"
                  type="button"
                  :aria-pressed="isOrgSelected(org.gid)"
                  class="flex w-full items-center gap-3 rounded-xl border bg-white px-3 py-2.5 text-left transition-colors dark:bg-slate-900"
                  :class="isOrgSelected(org.gid)
                    ? 'border-azure-500 bg-azure-500/5'
                    : 'border-slate-200 hover:bg-azure-500/5 dark:border-slate-700'"
                  @click="toggleOrg(org.gid)"
                >
                  <span
                    class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
                    :class="isOrgSelected(org.gid)
                      ? 'border-azure-500 bg-azure-500 text-white'
                      : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800'"
                  >
                    <IconCheck v-if="isOrgSelected(org.gid)" class="h-3.5 w-3.5" />
                  </span>
                  <img
                    v-if="org.logo"
                    :src="org.logo"
                    :alt="`${org.name} logo`"
                    class="h-8 w-8 shrink-0 rounded-sm object-cover d-mask d-mask-squircle"
                  >
                  <div
                    v-else-if="org.logo_is_loading"
                    class="flex h-8 w-8 shrink-0 items-center justify-center bg-gray-700 d-mask d-mask-squircle"
                    :aria-label="t('loading')"
                  >
                    <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                  </div>
                  <div
                    v-else
                    class="flex h-8 w-8 shrink-0 items-center justify-center bg-gray-700 text-xs font-semibold text-gray-300 d-mask d-mask-squircle"
                  >
                    {{ acronym(org.name) }}
                  </div>
                  <span class="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {{ org.name }}
                  </span>
                </button>

                <p v-if="orgs.length === 0" class="px-3 py-6 text-center text-sm text-slate-400">
                  {{ t('connect-no-org') }}
                </p>
              </div>
            </div>
            <p v-if="orgs.length > 0" class="mt-2 text-xs text-slate-400 dark:text-slate-500">
              {{ t('connect-orgs-selected', { count: selectedOrgIds.length, total: orgs.length }) }}
            </p>
          </div>

          <!-- Role -->
          <div>
            <label for="connect-role-select" class="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ t('connect-role') }}
            </label>
            <select
              id="connect-role-select"
              v-model="role"
              class="w-full appearance-none rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none focus:border-azure-500 focus:ring-2 focus:ring-azure-500/25 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="member">
                {{ t('connect-role-member') }}
              </option>
              <option value="admin">
                {{ t('connect-role-admin') }}
              </option>
            </select>
          </div>

          <!-- Member: per-app picker — each ticked app gets its own permission -->
          <ConnectAppPicker
            v-if="role === 'member'"
            v-model="selectedApps"
            :apps="apps"
            :show-org="selectedOrgIds.length > 1"
          />

          <!-- Admin: full-org note + optional org-create capability -->
          <template v-else>
            <div class="rounded-2xl border border-azure-500/35 bg-azure-500/5 p-4">
              <div class="flex items-start gap-2.5">
                <IconLock class="mt-0.5 h-5 w-5 shrink-0 text-azure-500" />
                <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {{ t('connect-admin-note', { org: selectedOrgNames.join(', ') || '—' }) }}
                </p>
              </div>
            </div>

            <label class="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-slate-700 dark:bg-slate-800/50">
              <input
                v-model="allowOrgCreate"
                type="checkbox"
                class="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-azure-500 focus:ring-2 focus:ring-azure-500/30 dark:border-slate-600"
              >
              <span class="min-w-0">
                <span class="block text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('connect-allow-org-create') }}</span>
                <span class="mt-0.5 block text-xs text-slate-400">{{ t('connect-allow-org-create-hint') }}</span>
              </span>
            </label>
          </template>
        </div>

        <div class="mt-7">
          <button
            type="button"
            :disabled="!canGenerate"
            class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-[#244366] to-azure-500 px-4 py-3.5 text-base font-semibold text-white shadow-md transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            @click="generate"
          >
            <IconKey class="h-5 w-5" />
            <span v-if="isGenerating">{{ t('loading') }}</span>
            <span v-else>{{ t('connect-generate') }}</span>
          </button>
        </div>

        <div class="mt-5 flex items-start gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
          <IconLock class="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <p class="text-xs leading-5 text-slate-400">
            {{ t('connect-key-ready-desc') }}
          </p>
        </div>
      </div>

      <!-- ============ SUCCESS VIEW ============ -->
      <div
        v-else
        class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-7"
      >
        <div class="flex flex-col items-center text-center">
          <span class="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-success/15">
            <IconCheckCircle class="h-7 w-7 text-success" />
          </span>
          <h2 class="mt-4 text-2xl font-semibold leading-tight text-slate-950 dark:text-white">
            {{ t('connect-key-ready') }}
          </h2>
          <p class="mt-2 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">
            {{ t('connect-key-ready-desc') }}
          </p>
          <div class="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-900">
            <span>{{ scopeChip }}</span>
          </div>
        </div>

        <!-- API key -->
        <div class="mt-6">
          <label class="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {{ t('connect-key-label') }}
          </label>
          <div class="flex items-stretch gap-2">
            <code class="flex-1 truncate rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-3 font-mono text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100">
              {{ generatedKey }}
            </code>
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-700 transition-colors hover:border-azure-500/45 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              @click="copy(generatedKey ?? '')"
            >
              <IconClipboard class="h-4 w-4" />
              <span>{{ t('connect-copy') }}</span>
            </button>
          </div>
        </div>

        <!-- Paste this to your AI -->
        <div class="mt-4 rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <p class="text-[0.72rem] font-bold uppercase tracking-[0.18em] text-slate-500">
            {{ t('connect-paste-title') }}
          </p>
          <div class="mt-2 flex items-stretch gap-2">
            <code class="flex-1 truncate rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3.5 py-2.5 font-mono text-xs text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200">
              {{ pasteLine }}
            </code>
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:border-azure-500/45 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              @click="copy(pasteLine)"
            >
              <IconClipboard class="h-4 w-4" />
              <span>{{ t('connect-copy') }}</span>
            </button>
          </div>
          <p class="mt-2 text-xs text-slate-400">
            {{ t('connect-paste-hint') }}
          </p>
        </div>

        <!-- Back -->
        <div class="mt-6">
          <button
            type="button"
            class="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3.5 text-base font-semibold text-slate-700 transition-colors hover:border-azure-500/45 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
            @click="back"
          >
            <IconArrowLeft class="h-5 w-5" />
            {{ t('connect-back') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
