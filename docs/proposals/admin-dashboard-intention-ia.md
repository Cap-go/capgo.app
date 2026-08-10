# Admin Dashboard: Intention-Based Information Architecture

**Status:** Proposal (no product behavior change in this PR)  
**Goal:** Reorganize Capgo admin around *what an admin wants to decide*, not around product features.  
**UI primitive:** Reuse `src/components/Tabs.vue` primary + `secondaryTabs` (same pattern as app/settings layouts).

---

## Problem

Today the admin is a flat feature list in one primary tab row:

`Builder · Updates · Replication · Plugins · CLI · Users · Organizations · Revenue · Credits · Notifications`

That causes three concrete issues:

1. **Mixed intentions on one page** — `Users` mixes onboarding funnel, trial lists, churn tables, email/country demographics, plan distribution, and product activity charts.
2. **Related signals split across tabs** — retention lives partly in `Users` (cancelled orgs) and partly in `Revenue` (NRR/churn). Feature health is split across `Updates`, `Plugins`, `CLI`, `Builder`, `Notifications`.
3. **Hard to answer onboarding questions** — improving onboarding needs a dedicated surface. Funnel + sources + activation sit buried inside a long `Users` scroll with unrelated cards.

Admins do not wake up thinking “open Plugins.” They wake up thinking:

- Are new users getting stuck in onboarding?
- Are paying customers healthy?
- Is the product working?
- Is revenue at risk?
- Who needs help today?
- Is the platform healthy?

---

## Proposed navigation

Use **intention hubs as primary tabs**, and **existing feature pages as secondary tabs** where a hub has multiple surfaces.

This matches the current `Tabs` API already used in `src/layouts/app.vue`:

```vue
<Tabs
  :tabs="primaryTabs"
  :active-tab="activeTab"
  :secondary-tabs="secondaryTabs"
  :secondary-active-tab="activeSecondaryTab"
  no-wrap
  @update:active-tab="handleTab"
  @update:secondary-active-tab="handleSecondaryTab"
/>
```

`src/layouts/admin.vue` already renders `Tabs`; it only needs the same secondary-tab wiring app/settings already have.

### Primary tabs (intention)

| Primary | Intention | Secondary tabs |
| --- | --- | --- |
| **Pulse** | What needs attention today? | none (single landing) |
| **Onboarding** | Is onboarding working? | Funnel · Sources · Cohorts |
| **Product** | Are features used and healthy? | Updates · Plugins · CLI · Builder · Notifications |
| **Retention** | Are users staying or giving up? | Trials · Churn · Inactive |
| **Customers** | Who needs help / management? | Organizations · Credits |
| **Revenue** | Is the business healthy? | Overview · Upgrades · Risk |
| **Platform** | Is Capgo infra healthy? | Replication · Capacity · Debug |

Top row goes from **10 feature tabs → 7 intention tabs**. Detail stays reachable through the secondary row instead of disappearing.

---

## Content mapping (current → proposed)

### 1. Pulse (new default landing, no sub-tabs)

**Question:** What should I look at first this morning?

| Widget | Source today | Click-through |
| --- | --- | --- |
| New registrations | `users` | Onboarding → Funnel |
| Activation rate | `users` onboarding funnel | Onboarding → Funnel |
| Trials expiring ≤7d | `users` trial list | Retention → Trials |
| Past-due / need-upgrade | `revenue` | Revenue → Risk |
| Update success rate | `updates` | Product → Updates |
| Replica lag / builder queue | `replication` / `builder` | Platform |

Rules: KPI row only + attention list. No deep charts.

### 2. Onboarding ★ priority for current work

**Question:** Do users succeed at becoming real Capgo users?

#### Secondary: Funnel

- Funnel stages + step conversion rates
- Onboarding trend (registrations / first app / first bundle / first device / first update in **one** multi-series chart)
- Register → subscription conversion

#### Secondary: Sources

- Registrations by source (normal / invite / without profile)
- Invite join trend
- Email type mix
- Country mix

#### Secondary: Cohorts *(new tracking to add)*

- Stuck after app / channel / bundle / device
- Time-to-each-stage (p50/p90)
- Signup-week cohort funnel

**Move out of current Users page:**

- Paid org cards → Revenue / Pulse
- Trial + cancelled tables → Retention
- Plan distribution → Revenue
- Apps-with-preview / versions-uploaded → Product

### 3. Product (secondary = current feature pages)

**Question:** Are Capgo features good and adopted?

| Secondary | Current page |
| --- | --- |
| Updates | `updates.vue` |
| Plugins | `plugins.vue` |
| CLI | `cli.vue` |
| Builder | `builder.vue` usage/analytics blocks |
| Notifications | `notifications.vue` |

Chart rule: merge related series when period/unit match; KPI cards only for latest snapshot.

### 4. Retention

**Question:** Are users staying, or giving up Capgo?

| Secondary | Content |
| --- | --- |
| Trials | Trial table, trial plan breakdown, trial-extension conversion |
| Churn | Cancelled orgs + reasons, active canceled, logo churn / NRR narrative |
| Inactive | Paying orgs with no upload / no MAU (from org insights) |

### 5. Customers

**Question:** Manage a specific user/org or resolve an issue.

| Secondary | Current page |
| --- | --- |
| Organizations | `organizations.vue` |
| Credits | `credits.vue` grant UI + recent grants |

Row-oriented ops UI, not a chart wall.

### 6. Revenue

**Question:** Is money healthy?

| Secondary | Content |
| --- | --- |
| Overview | MRR / ARR / LTV / plan mix / paying mix |
| Upgrades | Upgrade rate, above-plan |
| Risk | Past-due, subscription flow new vs canceled |

Logo-churn customer lists stay in Retention; money metrics stay here.

### 7. Platform

**Question:** Is Capgo itself healthy?

| Secondary | Content |
| --- | --- |
| Replication | `replication.vue` |
| Capacity | Builder online/offline/queue from `builder.vue` |
| Debug | `debug.vue` |

---

## IA diagram

```text
Admin (Tabs.vue)
├── Pulse                         ← default landing
├── Onboarding
│   ├── Funnel                    ← secondaryTabs
│   ├── Sources
│   └── Cohorts
├── Product
│   ├── Updates
│   ├── Plugins
│   ├── CLI
│   ├── Builder
│   └── Notifications
├── Retention
│   ├── Trials
│   ├── Churn
│   └── Inactive
├── Customers
│   ├── Organizations
│   └── Credits
├── Revenue
│   ├── Overview
│   ├── Upgrades
│   └── Risk
└── Platform
    ├── Replication
    ├── Capacity
    └── Debug
```

---

## Implementation sketch (admin layout)

Mirror `src/layouts/app.vue`:

1. `constants/adminTabs.ts` — primary intention tabs only.
2. New constants per hub, e.g. `adminOnboardingTabs.ts`, `adminProductTabs.ts`, …
3. `layouts/admin.vue` — compute `secondaryTabs` from active primary prefix, pass into `Tabs`.
4. Routes become nested under intention prefixes, e.g.:
   - `/admin/dashboard/onboarding`
   - `/admin/dashboard/onboarding/sources`
   - `/admin/dashboard/product/updates`
   - `/admin/dashboard/customers/credits`
5. Keep old URLs as redirects during migration.

No new tab component. Same primary “open tab” style + secondary pill row already in production.

---

## UX rules

1. **One intention per primary tab.**
2. **Secondary tabs only when the hub has multiple decisions/surfaces.** Pulse stays flat.
3. **Cards = now, charts = over time.** Do not duplicate the same metric as card + lonely single-series chart.
4. **Merge related series** into one chart when axes match.
5. **Tables are for action** (Retention / Customers), not mixed into demographic chart walls.

---

## Suggested rollout

### Phase 0 — this PR

- Agree IA + visual mock using primary + secondary Tabs
- No route renames yet

### Phase 1 — Onboarding hub

- Extract onboarding from `users.vue`
- Add Funnel / Sources / Cohorts secondary tabs
- Add stuck-cohort + time-to-stage metrics

### Phase 2 — Customers + Retention split

- Organizations + Credits as Customers secondary tabs
- Trials / Churn / Inactive as Retention secondary tabs

### Phase 3 — Product + Platform wrap

- Move existing feature pages under Product / Platform secondary tabs
- Remove old flat feature keys from primary `adminTabs`

### Phase 4 — Pulse landing

- Replace `index → users` redirect with Pulse

---

## Success criteria

- Admin can answer “is onboarding good?” from Onboarding primary + its secondary tabs only.
- Primary nav ≤ 7 intention tabs.
- Existing feature pages remain one click away via secondary tabs.
- Onboarding improvements become measurable: stage conversion, time-to-stage, stuck cohorts.

---

## Open questions for Martin

1. Default landing: **Pulse** or **Onboarding** while activation work is hot?
2. Keep **Credits** under Customers secondary, or privileged-only entry?
3. Builder **usage** under Product and builder **capacity** under Platform — confirm split.
4. Add i18n keys for new hub/sub-tab labels in Phase 1, or English-only until IA stabilizes?
