# Backend onboarding refresh

The existing scheduler enqueues `cron_onboarding_refresh` every ten minutes.
Its backend producer atomically leases up to 3,000 oldest due apps and writes
`cron_onboarding_refresh_apps` messages containing at most twenty app IDs each.
The minute consumer dispatches one group of fifteen messages: at most 300 apps.
All apps remain eligible, independent of billing or checklist version. A full
sweep can take longer than ten minutes when more than 3,000 apps are due.

Pending leases prevent duplicate enqueueing. Thirty-minute expired leases can
be replaced by a producer; tokens make replaced or already-completed messages
harmless. The global five-read queue ceiling remains unchanged. Provider failure
leaves onboarding and leases untouched, allowing bounded queue retries and later
producer recovery. Deleted apps remove their leases through the foreign key.

Workers issue two grouped Cloudflare Analytics Engine SQL queries per twenty
apps, filtered by app index and the later of creation or three-month retention.
`version_usage.install` is emitted by production, non-emulator `set` reports;
its event timestamps provide OTA success/usage without `daily_version`.
`device_info` provides device contact and install-source stages without reading
Supabase's device rollup. First/last bundle and builder timestamps use ordered
owning-app index lookups in PostgreSQL. The worker preserves setup, historic
milestones, unrelated features, stage precedence, and thirty-day retention.
Analytics Engine sampling means a missing result is not proof no event occurred;
existing confirmed milestones are never cleared.

Both internal routes require the API secret. Cloudflare reads have a shared
ten-second abort deadline; missing configuration and malformed responses fail
the job rather than masquerading as empty results. Each worker uses a short
write transaction with ten-second statement and two-second lock timeouts.
The queue consumer runs all fifteen requests concurrently with a 45-second
HTTP timeout, awaits queue acknowledgments, and has a 120-second visibility
window. The scheduler makes one awaited dispatch with a 60-second pg_net
timeout for these queues, instead of the generic ten-dispatch fan-out.

SQL execution is internal only: one producer call per scheduled message; at most
3,000 output apps, refresh-expression index ordering, and lease primary-key
lookups. Worker transactions touch at most twenty apps via primary keys. The
three JSON merge calls per app are existing pure functions with no table scans.
Bundle lookups use `idx_app_versions_onboarding_created`; builder lookups use
the existing app/created index and the new success/last-use indexes. The new
lease table and producer function deny anon/authenticated access. No plugin
hot path, checklist experiment assignment, or email delivery is changed.

The old scheduled SQL batch function is dropped. The single-app SQL refresh
function remains because the Getting Started Verify RPC calls it on demand.

Query plan validation uses synthetic data, without customer identifiers: 20,000
apps, 500,000 bundles and 200,000 builds. PostgreSQL 17 chose the refresh-order
index plus lease PK for a 3,000-app producer selection (3.04 ms), and index-only
first-bundle/successful-build lookups (0.04/0.03 ms). Eight parallel bundle
lookups completed in 13 ms; an unrelated org read completed in 6 ms. These
local measurements establish the lookup shape, not a production latency SLA.
Anon/authenticated/API-key callers cannot invoke the new producer or lease
path; no new SQL function is added to a public policy, view, or plugin path.
