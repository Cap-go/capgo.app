# Stale Current Organization Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `currentOrganization` valid after an organization refresh removes the previously selected organization.

**Architecture:** Keep selection restoration inside the Pinia organization store. Validate both the in-memory and persisted organization IDs against the freshly fetched selectable organizations, then fall back to the first selectable organization.

**Tech Stack:** Vue 3, Pinia, TypeScript, Vitest, Bun

---

### Task 1: Reproduce the stale selection

**Files:**
- Modify: `tests/organization-store-delete.unit.test.ts`

- [ ] **Step 1: Write the failing regression test**

Add a test that fetches organization A, then refreshes the store with only
organization B available:

```ts
it('falls back when the selected organization disappears during refresh', async () => {
  const organizationA = {
    gid: 'org-removed',
    role: 'org_super_admin',
    app_count: 1,
    created_by: 'owner-a',
    name: 'Removed Org',
    logo: null,
    password_policy_config: null,
    enforcing_2fa: false,
    '2fa_has_access': true,
    password_has_access: true,
    paying: true,
    trial_left: 0,
    can_use_more: true,
  }
  const organizationB = {
    ...organizationA,
    gid: 'org-remaining',
    created_by: 'owner-b',
    name: 'Remaining Org',
  }
  mockRpc
    .mockResolvedValueOnce({ data: [organizationA], error: null })
    .mockResolvedValueOnce({ data: [organizationB], error: null })

  const { useOrganizationStore } = await import('../src/stores/organization.ts')
  const store = useOrganizationStore(createPinia())

  await store.fetchOrganizations()
  expect(store.currentOrganization?.gid).toBe('org-removed')

  await store.fetchOrganizations()

  expect(store.organizations.map(org => org.gid)).toEqual(['org-remaining'])
  expect(store.currentOrganization?.gid).toBe('org-remaining')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bunx vitest run tests/organization-store-delete.unit.test.ts
```

Expected: the new assertion fails because `currentOrganization` is undefined
after the second refresh.

### Task 2: Validate refreshed selection candidates

**Files:**
- Modify: `src/stores/organization.ts:598-611`
- Test: `tests/organization-store-delete.unit.test.ts`

- [ ] **Step 1: Implement the minimal fallback**

Replace ID preservation with fresh-object selection:

```ts
let selectedOrganization = currentOrganization.value
  ? selectableOrganizations.find(org => org.gid === currentOrganization.value?.gid)
  : undefined

if (!selectedOrganization) {
  const storedOrgId = localStorage.getItem(STORAGE_KEY)
  if (storedOrgId)
    selectedOrganization = selectableOrganizations.find(org => org.gid === storedOrgId)
}

currentOrganization.value = selectedOrganization ?? organization
```

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
bunx vitest run tests/organization-store-delete.unit.test.ts
```

Expected: all tests in the file pass with zero failures.

- [ ] **Step 3: Verify the regression test detects removal of the fix**

Temporarily restore the old selection logic, rerun the focused test and confirm
the new case fails, then restore the implementation and rerun it to confirm it
passes.

- [ ] **Step 4: Commit the regression fix**

```bash
git add src/stores/organization.ts tests/organization-store-delete.unit.test.ts
git commit -m "fix(frontend): recover stale organization selection"
```

### Task 3: Complete local verification

**Files:**
- Verify: `src/stores/organization.ts`
- Verify: `tests/organization-store-delete.unit.test.ts`

- [ ] **Step 1: Run formatting and lint validation**

```bash
bun lint
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 2: Run the frontend type checker**

```bash
bun typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run the complete unit suite**

```bash
bun test:unit
```

Expected: exit code 0 with no failed tests.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff origin/main...HEAD --check
git status --short
```

Expected: no whitespace errors and only the unrelated pre-existing
`codedb.snapshot` worktree modification remains unstaged.

- [ ] **Step 5: Push and create the pull request**

```bash
git push -u origin wolny/fix-stale-current-organization
gh pr create --base main --head wolny/fix-stale-current-organization
```

Expected: an open, non-draft pull request URL.

- [ ] **Step 6: Apply the `pr-ready` stable-green workflow**

Inspect all checks, reviews, unresolved conversations, mergeability, and branch
requirements. Record observation A only after all gates pass, then fetch fresh
state at least 300 seconds later and record observation B if no relevant state
changed.
