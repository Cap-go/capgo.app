# API Key Hidden-Scope Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain when scope filtering hides API keys and provide an accessible action that clears every scope selection without clearing search.

**Architecture:** Move the API-key list's search-then-scope calculation into a small pure helper in the existing API-key service so its hidden count can be tested independently. The API keys page consumes that result, while an optional `DataTable` slot places page-owned status content between the toolbar and column headers.

**Tech Stack:** Vue 3 Composition API, TypeScript, vue-i18n, Tailwind CSS, Vitest, Bun.

---

## File structure

- Modify `src/services/apikeys.ts`: add pure list filtering and scope-clearing helpers.
- Create `tests/apikey-list-filtering.unit.test.ts`: verify hidden-count, search interaction, and scope-clearing behavior.
- Modify `src/components/DataTable.vue`: expose an optional notice slot between the toolbar and the table.
- Modify `src/pages/ApiKeys.vue`: consume the filter result and render the conditional notice.
- Modify `messages/en.json`: add singular, plural, and action copy.
- Create `tests/apikey-hidden-scope-notice.unit.test.ts`: protect the slot boundary and page integration contract.

### Task 1: API-key visibility calculation

**Files:**
- Create: `tests/apikey-list-filtering.unit.test.ts`
- Modify: `src/services/apikeys.ts`

- [ ] **Step 1: Write the failing filter-helper tests**

Create rows with explicit organization IDs, app IDs, and searchable values, then exercise the helper through typed accessors:

```ts
import { describe, expect, it } from 'vitest'
import { clearApiKeyScopeFilters, filterApiKeyListRows } from '../src/services/apikeys'

interface Row {
  id: number
  orgIds: string[]
  appIds: string[]
  searchableValues: string[]
}

const rows: Row[] = [
  { id: 1, orgIds: ['org-a'], appIds: ['app-a'], searchableValues: ['Alpha key'] },
  { id: 2, orgIds: ['org-b'], appIds: ['app-b'], searchableValues: ['Beta key'] },
  { id: 3, orgIds: ['org-b'], appIds: ['app-c'], searchableValues: ['Alpha release'] },
]

const accessors = {
  getOrgIds: (row: Row) => row.orgIds,
  getAppIds: (row: Row) => row.appIds,
  getSearchableValues: (row: Row) => row.searchableValues,
}
```

Assert that an `org-a` filter returns row 1 and reports two hidden rows; an `org-a` filter plus the search `alpha` reports one hidden row; a scope matching every searchable row reports zero; no scope reports zero; and combined organization/app filters preserve the existing AND-between-groups behavior. Also assert:

```ts
expect(clearApiKeyScopeFilters({ 'org:org-a': true, 'app:app-a': true })).toEqual({
  'org:org-a': false,
  'app:app-a': false,
})
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
bun vitest run tests/apikey-list-filtering.unit.test.ts
```

Expected: FAIL because `filterApiKeyListRows` and `clearApiKeyScopeFilters` are not exported.

- [ ] **Step 3: Implement the pure helpers**

Add these public types and functions near the existing API-key list helpers in `src/services/apikeys.ts`:

```ts
export interface ApiKeyListFilterOptions<T> {
  searchQuery: string
  orgFilterIds: string[]
  appFilterIds: string[]
  getOrgIds: (row: T) => string[]
  getAppIds: (row: T) => string[]
  getSearchableValues: (row: T) => Array<string | null | undefined>
}

export interface ApiKeyListFilterResult<T> {
  rows: T[]
  hiddenByScopeCount: number
}

export function clearApiKeyScopeFilters(filters: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.keys(filters).map(key => [key, false]))
}

export function filterApiKeyListRows<T>(
  rows: T[],
  options: ApiKeyListFilterOptions<T>,
): ApiKeyListFilterResult<T> {
  const query = options.searchQuery.toLowerCase()
  const searchableRows = query
    ? rows.filter(row => options.getSearchableValues(row)
        .some(value => value?.toLowerCase().includes(query)))
    : [...rows]

  let scopedRows = searchableRows
  if (options.orgFilterIds.length > 0) {
    scopedRows = scopedRows.filter(row => options.orgFilterIds
      .some(orgId => options.getOrgIds(row).includes(orgId)))
  }
  if (options.appFilterIds.length > 0) {
    scopedRows = scopedRows.filter(row => options.appFilterIds
      .some(appId => options.getAppIds(row).includes(appId)))
  }

  const hasScopeFilter = options.orgFilterIds.length > 0 || options.appFilterIds.length > 0
  return {
    rows: scopedRows,
    hiddenByScopeCount: hasScopeFilter ? searchableRows.length - scopedRows.length : 0,
  }
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
bun vitest run tests/apikey-list-filtering.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper and tests**

```bash
git add src/services/apikeys.ts tests/apikey-list-filtering.unit.test.ts
git commit -m "feat(frontend): compute hidden API key scopes"
```

### Task 2: Inline notice and clearing action

**Files:**
- Create: `tests/apikey-hidden-scope-notice.unit.test.ts`
- Modify: `src/components/DataTable.vue`
- Modify: `src/pages/ApiKeys.vue`
- Modify: `messages/en.json`

- [ ] **Step 1: Write the failing integration-contract test**

Read the two Vue source files and English messages. Assert that:

```ts
expect(dataTableSource.indexOf('<slot name="table-notice" />'))
  .toBeLessThan(dataTableSource.indexOf('<div class="block">'))
expect(apiKeysSource).toContain('<template #table-notice>')
expect(apiKeysSource).toContain('v-if="!isLoading && hiddenByScopeCount > 0"')
expect(apiKeysSource).toContain('role="status"')
expect(apiKeysSource).toContain('@click="clearScopeFilters()"')
expect(messages['remove-api-key-scope-filter']).toBe('Remove the filter')
```

Also assert that the page uses separate singular and plural message keys with the plural call passing `{ count: hiddenByScopeCount }`.

- [ ] **Step 2: Run both focused tests and confirm the new contract fails**

Run:

```bash
bun vitest run tests/apikey-list-filtering.unit.test.ts tests/apikey-hidden-scope-notice.unit.test.ts
```

Expected: the helper tests PASS and the integration-contract test FAILS because the slot, copy, and notice do not exist.

- [ ] **Step 3: Add the optional table slot**

In `src/components/DataTable.vue`, render the slot after the toolbar container closes and before the existing `<div class="block">` table wrapper:

```vue
<slot name="table-notice" />
<div class="block">
```

The slot itself adds no wrapper, so tables that do not provide content keep identical markup and spacing.

- [ ] **Step 4: Refactor the API-key page to consume the filter result**

Import `clearApiKeyScopeFilters` and `filterApiKeyListRows` from `~/services/apikeys`. Change `clearScopeFilters` to assign `clearApiKeyScopeFilters(scopeFilters.value)` and keep its existing user-change and page-reset behavior.

Replace the current monolithic `filteredAndSortedKeys` calculation with:

```ts
const apiKeyFilterResult = computed(() => filterApiKeyListRows(keys.value ?? [], {
  searchQuery: searchQuery.value,
  orgFilterIds: selectedScopeFilterIds('org'),
  appFilterIds: selectedScopeFilterIds('app'),
  getOrgIds: getFilterOrgIds,
  getAppIds: getDisplayAppIds,
  getSearchableValues: key => [
    key.name,
    key.key,
    getRoleDisplayName(getHighestRole(key) || ''),
    formatDisplayOrganizations(key),
    formatDisplayApps(key),
  ],
}))

const hiddenByScopeCount = computed(() => apiKeyFilterResult.value.hiddenByScopeCount)

const filteredAndSortedKeys = computed(() => {
  const result = apiKeyFilterResult.value.rows
  return columns.value.length ? sortApiKeyRows(result, columns.value) : result
})
```

- [ ] **Step 5: Add translated notice copy**

Add these keys to `messages/en.json` in alphabetical position:

```json
"api-key-hidden-by-scope-filter-one": "1 API key is hidden by the current scope filter.",
"api-keys-hidden-by-scope-filter-many": "{count} API keys are hidden by the current scope filter.",
"remove-api-key-scope-filter": "Remove the filter",
```

- [ ] **Step 6: Render the accessible notice**

Provide this slot to `DataTable` after its existing event bindings:

```vue
<template #table-notice>
  <div
    v-if="!isLoading && hiddenByScopeCount > 0"
    role="status"
    class="mx-3 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-sm text-cyan-900 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-100"
  >
    <span>
      {{ hiddenByScopeCount === 1
        ? t('api-key-hidden-by-scope-filter-one')
        : t('api-keys-hidden-by-scope-filter-many', { count: hiddenByScopeCount }) }}
    </span>
    <button
      type="button"
      class="rounded-sm font-semibold text-cyan-700 underline underline-offset-2 hover:text-cyan-900 focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:text-cyan-200 dark:hover:text-white dark:focus-visible:ring-offset-slate-800"
      @click="clearScopeFilters()"
    >
      {{ t('remove-api-key-scope-filter') }}
    </button>
  </div>
</template>
```

- [ ] **Step 7: Run the focused tests and confirm they pass**

Run:

```bash
bun vitest run tests/apikey-list-filtering.unit.test.ts tests/apikey-hidden-scope-notice.unit.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the notice UI**

```bash
git add src/components/DataTable.vue src/pages/ApiKeys.vue messages/en.json tests/apikey-hidden-scope-notice.unit.test.ts
git commit -m "feat(frontend): warn about hidden API keys"
```

### Task 3: Full frontend verification

**Files:**
- Verify only; fix any issue in the files changed by Tasks 1–2.

- [ ] **Step 1: Run frontend lint**

```bash
bun lint
```

Expected: PASS with no lint errors in changed files.

- [ ] **Step 2: Run TypeScript checking**

```bash
bun typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the production build**

```bash
bun build
```

Expected: PASS and emit the production bundle.

- [ ] **Step 4: Re-run focused regression tests**

```bash
bun vitest run tests/apikey-list-filtering.unit.test.ts tests/apikey-hidden-scope-notice.unit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit verification fixes if needed**

If verification required changes, stage only the files modified for this feature and commit them:

```bash
git add src/services/apikeys.ts src/components/DataTable.vue src/pages/ApiKeys.vue messages/en.json tests/apikey-list-filtering.unit.test.ts tests/apikey-hidden-scope-notice.unit.test.ts
git commit -m "fix(frontend): finalize API key scope notice"
```

### Task 4: Refine the notice as a neutral information banner

**Files:**
- Modify: `src/components/ApiKeyHiddenScopeNotice.vue`
- Modify: `tests/apikey-hidden-scope-notice.unit.test.ts`

- [ ] **Step 1: Add the failing visual contract assertions**

Extend the mounted notice test to require a circled-information icon and the
neutral banner palette:

```ts
expect(status?.querySelector('[data-test="scope-notice-icon"]')).not.toBeNull()
expect(status?.classList.contains('border-slate-200')).toBe(true)
expect(status?.classList.contains('bg-slate-50')).toBe(true)
expect(status?.className).not.toContain('cyan')
expect(button?.classList.contains('text-blue-600')).toBe(true)
```

- [ ] **Step 2: Run the focused test and confirm it fails**

```bash
bunx vitest run tests/apikey-hidden-scope-notice.unit.test.ts
```

Expected: FAIL because the current banner has no information icon and uses the
cyan palette.

- [ ] **Step 3: Implement the neutral information banner**

Import `~icons/heroicons/information-circle`, render it with
`aria-hidden="true"` and `data-test="scope-notice-icon"`, and change the banner
to slate border/background/body classes. Keep blue only on the icon, action,
and focus ring. Preserve the existing status role, copy, responsive wrapping,
and emitted `removeFilter` action.

- [ ] **Step 4: Validate the refinement**

```bash
bunx vitest run tests/apikey-hidden-scope-notice.unit.test.ts tests/apikey-list-filtering.unit.test.ts tests/frontend-channel-rbac-scope.test.ts
bunx eslint src/components/ApiKeyHiddenScopeNotice.vue tests/apikey-hidden-scope-notice.unit.test.ts
bun typecheck
```

Expected: 17 focused tests pass, ESLint passes, and typechecking passes.

- [ ] **Step 5: Commit and push**

```bash
git add docs/superpowers/specs/2026-08-11-api-key-hidden-scope-notice-design.md docs/superpowers/plans/2026-08-11-api-key-hidden-scope-notice.md src/components/ApiKeyHiddenScopeNotice.vue tests/apikey-hidden-scope-notice.unit.test.ts
git commit -m "fix(frontend): restyle API key scope notice"
git push origin wolny/api-key-hidden-scope-notice
```
