# Admin Dashboard: Intention-Based Information Architecture

**Status:** Implemented (this PR)  
**UI primitive:** `src/components/Tabs.vue` primary + `secondaryTabs` (same pattern as app/settings)

## What changed

Admin is no longer a flat feature list. Primary tabs are intentions; secondary tabs are the surfaces inside each intention.

| Primary | Secondary |
| --- | --- |
| Pulse | — |
| Onboarding | Funnel · Sources · Cohorts |
| Product | Updates · Plugins · CLI · Builder · Notifications |
| Retention | Trials · Churn · Inactive |
| Customers | Organizations · Credits |
| Revenue | Overview · Upgrades · Risk |
| Platform | Replication · Capacity · Debug |

Legacy URLs (`/admin/dashboard/users`, `/updates`, …) redirect to the new hubs.

## Layout wiring

`src/layouts/admin.vue` mirrors `src/layouts/app.vue`: primary tab keeps the hub active; secondary tabs switch within the hub.

## Onboarding focus

`users.vue` was split into:

- `/admin/dashboard/onboarding` — funnel + trends
- `/admin/dashboard/onboarding/sources` — registration sources / email / country
- `/admin/dashboard/onboarding/cohorts` — stuck-stage attention from live funnel stats
- `/admin/dashboard/retention/*` — trials / churn / inactive

## Screenshots

Real product captures (local worktree, `admin@capgo.app`):

- `docs/pr-assets/admin-intention-ia/real-onboarding-funnel.png`
- `docs/pr-assets/admin-intention-ia/real-product-updates.png`
- `docs/pr-assets/admin-intention-ia/real-pulse.png`
