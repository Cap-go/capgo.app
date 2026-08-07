# Expired Trial Plans State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a clear, neutral expired-trial state on the plans page for organizations that never paid, without changing any previously subscribed state.

**Architecture:** Reuse the dashboard billing-history distinction through a small pure service that treats `stripe_info.paid_at === null` as never paid. The plans page loads that value with stale-response protection, derives one `showExpiredTrialState` computed value, and uses it to switch header copy, suppress the misleading error banner, and neutralize plan cards only for expired trials.

**Tech Stack:** Vue 3 Composition API, Pinia, Supabase JS, vue-i18n, Vitest, Tailwind CSS

---

## File Structure

- Create `src/services/paymentRequired.ts`: shared pure billing-history predicates used by dashboard and plans-page presentation.
- Create `tests/payment-required-copy.unit.test.ts`: focused resolver coverage for never-paid, previously paid, unresolved, missing-relation, and native states.
- Modify `src/pages/settings/organization/Plans.vue`: load `paid_at`, derive the expired-trial state, update header/banner/card treatment, and place secondary CTAs after the plan grid.
- Modify `messages/en.json`: add state-aware expired-trial heading and plan-specific action copy.

### Task 1: Shared Expired-Trial Resolver

**Files:**
- Create: `src/services/paymentRequired.ts`
- Create: `tests/payment-required-copy.unit.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

```ts
import { describe, expect, it } from 'vitest'
import { resolveBillingPaidAt, shouldShowExpiredTrialCopy } from '../src/services/paymentRequired'

describe('payment required copy', () => {
  it.concurrent('shows expired-trial copy for a never-paid web organization', () => {
    expect(shouldShowExpiredTrialCopy(false, null)).toBe(true)
  })

  it.concurrent('treats a missing billing relation as never paid', () => {
    expect(resolveBillingPaidAt(null)).toBe(null)
  })

  it.concurrent('keeps existing copy for a previously paid web organization', () => {
    expect(shouldShowExpiredTrialCopy(false, '2026-01-15T12:00:00.000Z')).toBe(false)
  })

  it.concurrent('keeps existing copy while billing history is unresolved', () => {
    expect(shouldShowExpiredTrialCopy(false, undefined)).toBe(false)
  })

  it.concurrent('never shows purchase-oriented trial copy in the native app', () => {
    expect(shouldShowExpiredTrialCopy(true, null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the focused test and verify that it fails**

Run: `bunx vitest run tests/payment-required-copy.unit.test.ts`

Expected: FAIL because `src/services/paymentRequired.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared resolver**

```ts
export function resolveBillingPaidAt(stripeInfo: { paid_at: string | null } | null): string | null {
  return stripeInfo?.paid_at ?? null
}

export function shouldShowExpiredTrialCopy(isNative: boolean, paidAt: string | null | undefined): boolean {
  return !isNative && paidAt === null
}
```

- [ ] **Step 4: Run the focused test and verify that it passes**

Run: `bunx vitest run tests/payment-required-copy.unit.test.ts`

Expected: PASS with five tests.

- [ ] **Step 5: Commit the resolver**

```bash
git add src/services/paymentRequired.ts tests/payment-required-copy.unit.test.ts
git commit -m "test(frontend): cover expired trial billing state"
```

### Task 2: State-Aware Plans Page

**Files:**
- Modify: `src/pages/settings/organization/Plans.vue`
- Modify: `messages/en.json`

- [ ] **Step 1: Add English translation keys**

Add these keys to `messages/en.json` in alphabetical order:

```json
"choose-plan-name": "Choose {plan}",
"trial-ended-plans-description": "Choose a plan to continue using Capgo.",
"trial-ended-title": "Your free trial has ended"
```

- [ ] **Step 2: Load billing history with organization-switch protection**

Import `shouldShowExpiredTrialCopy`, then add billing state beside the existing refs:

```ts
import { shouldShowExpiredTrialCopy } from '~/services/paymentRequired'

const paidAt = ref<string | null | undefined>(undefined)
const showExpiredTrialState = computed(() => {
  return organizationStore.currentOrganizationFailed
    && shouldShowExpiredTrialCopy(isMobile, paidAt.value)
})

let billingLookupRun = 0
watch(() => currentOrganization.value?.gid, async (orgId) => {
  const currentRun = ++billingLookupRun
  paidAt.value = undefined

  if (isMobile || !orgId)
    return

  const { data, error } = await useSupabase()
    .from('orgs')
    .select('stripe_info(paid_at)')
    .eq('id', orgId)
    .maybeSingle()

  if (currentRun !== billingLookupRun || error || !data)
    return

  paidAt.value = data.stripe_info?.paid_at ?? null
}, { immediate: true })
```

This query is read-only and uses the current authenticated client. Do not alter ended-subscription state or query Stripe directly.

- [ ] **Step 3: Render state-aware header copy and preserve existing paid-state behavior**

Change only the pricing heading and description:

```vue
<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
  {{ t(showExpiredTrialState ? 'trial-ended-title' : 'plan-pricing-plans') }}
</h1>
<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
  {{ t(showExpiredTrialState ? 'trial-ended-plans-description' : 'plan-desc') }}
</p>
```

Suppress the current red banner only for the proven expired-trial state:

```vue
<div v-if="organizationStore.currentOrganizationFailed && !showExpiredTrialState" class="px-4 py-2 mb-4 font-medium text-center text-white bg-red-500 rounded-lg shrink-0">
  {{ t('plan-failed') }}
</div>
```

Previously paid, canceled, unresolved, and lookup-error states must continue through the existing branch unchanged.

- [ ] **Step 4: Neutralize cards only for expired trials**

Return no recommendation for the expired-trial state:

```ts
function isRecommended(p: Database['public']['Tables']['plans']['Row']) {
  if (showExpiredTrialState.value)
    return false
  return currentPlanSuggest.value?.name === p.name && (currentPlanSuggest.value?.price_m ?? 0) > (currentPlan.value?.price_m ?? 0)
}
```

Make the expired-trial action identify the selected plan:

```ts
if (showExpiredTrialState.value)
  return t('choose-plan-name', { plan: p.name })
if (isTrial.value || organizationStore.currentOrganizationFailed)
  return t('plan-upgrade')
```

Gate only the current-plan outline in the plan-card class:

```vue
p.name === currentPlan?.name && !isCreditsOnly && !showExpiredTrialState
  ? 'border-2 border-blue-500'
  : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700'
```

- [ ] **Step 5: Put the primary plan choice before secondary CTAs**

Move the existing `CreditsCta` and expert-support blocks, unchanged internally, from above the plans grid to immediately below the grid. Do not add another expired-trial callout.

- [ ] **Step 6: Run focused tests and frontend typechecking**

Run: `bunx vitest run tests/payment-required-copy.unit.test.ts`

Expected: PASS.

Run: `bun run typecheck:frontend`

Expected: exit 0 with no Vue or TypeScript errors.

- [ ] **Step 7: Commit the plans-page behavior**

```bash
git add messages/en.json src/pages/settings/organization/Plans.vue
git commit -m "fix(frontend): clarify expired trial plans state"
```

### Task 3: Verification and Scope Guard

**Files:**
- Verify: `src/pages/settings/organization/Plans.vue`
- Verify: `src/services/paymentRequired.ts`
- Verify: `tests/payment-required-copy.unit.test.ts`

- [ ] **Step 1: Run formatting and lint before final validation**

Run: `bun run lint:fix`

Expected: exit 0; formatting changes, if any, are limited to touched frontend files.

- [ ] **Step 2: Run the focused unit test after formatting**

Run: `bunx vitest run tests/payment-required-copy.unit.test.ts`

Expected: PASS with five tests.

- [ ] **Step 3: Run frontend typechecking**

Run: `bun run typecheck:frontend`

Expected: exit 0.

- [ ] **Step 4: Review the final diff for scope**

Run: `git diff HEAD~2 -- messages/en.json src/pages/settings/organization/Plans.vue src/services/paymentRequired.ts tests/payment-required-copy.unit.test.ts`

Expected: only the never-paid expired-trial state changes. No ended-subscription, canceled-subscription, backend, schema, or migration behavior changes.

- [ ] **Step 5: Commit formatter-only changes if needed**

```bash
git add messages/en.json src/pages/settings/organization/Plans.vue src/services/paymentRequired.ts tests/payment-required-copy.unit.test.ts
git commit -m "style(frontend): format expired trial plans changes"
```

Skip this commit when the formatter produces no diff.
