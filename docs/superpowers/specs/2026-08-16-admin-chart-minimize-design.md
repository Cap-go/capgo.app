# Admin Chart Minimize Design

## Goal

Let administrators temporarily minimize any graph so dense dashboard pages are easier to scan while keeping every graph title and restore control visible.

## Interaction

- Graphs start from the signed-in administrator's saved state.
- A small circular chevron button sits at the top-right of each graph card.
- The expanded state uses an upward chevron to indicate “minimize.”
- The minimized state uses a downward chevron to indicate “expand.”
- Minimizing removes the graph, loading, error, total, and summary content, leaving one compact title row.
- The button exposes translated labels and `aria-expanded` state for assistive technology.
- State updates optimistically, so the card responds immediately while the preference is written in the background.

## Persistence

- Preferences live in the signed-in user's existing `public.users.onboarding` JSON under `admin_dashboard_minimize`.
- The existing authentication profile read (`main.user`) is the only database read needed. The admin dashboard store hydrates the preference map from that cached row once per user.
- Each graph uses a compact deterministic key derived from its admin route and title. The readable slug keeps stored data inspectable, while a stable hash prevents collisions.
- Toggling a graph updates the Pinia cache and `main.user` synchronously, then serializes a frontend Supabase update to the same user's row. No refetch follows a write.
- Every write merges the preference map into the latest locally cached onboarding JSON so wizard progress and unrelated keys are preserved.
- Existing onboarding-wizard persistence preserves `admin_dashboard_minimize` for platform administrators. It never copies or creates the object for normal users.
- Persistence is guarded by the existing `main.isAdmin` state and admin-dashboard route. No database migration, RPC, API endpoint, or `supabase/` change is part of this feature.

## Scope

`ChartCard` enables the control only for `/admin/dashboard` routes, so existing customer dashboards do not change. The custom funnel and onboarding-journey panels on the admin users and frontend-onboarding pages move into `ChartCard`, giving all current admin graphs the same interaction. Only administrators hydrate or write `admin_dashboard_minimize`; ordinary users never receive the field through application code.

## Verification

Add component and store unit coverage for admin visibility, cached hydration, optimistic toggles, merged writes, compact title retention, reload state, and non-admin behavior. Run the focused tests, frontend lint, typecheck, and a production build, then inspect the production-backed local page.
