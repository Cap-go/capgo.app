# Organization custom domains

Paying Enterprise organizations can manage one Live Updates API hostname in Organization settings. The private API provisions a Cloudflare for SaaS hostname and returns DNS ownership and certificate validation records. Refresh fetches live provider status; updater URLs are offered only when both the hostname and TLS certificate are active. Bundle download URLs are unchanged.

## Existing Cloudflare setup

Reuse the existing Cloudflare for SaaS fallback on the `capgo.app` zone. Customers point their CNAME to `plugin.capgo.app`. The API looks up the zone by name using the existing `CF_ANALYTICS_TOKEN`; no new environment variables or token are required.

Add Zone Read, SSL and Certificates Write, and Workers Routes Write permissions for `capgo.app` to that token. Provisioning creates the custom hostname and a hostname-specific `<hostname>/*` route to the existing `capgo_plugin-eu-prod` Worker. Removal deletes the saved route and then the hostname; failed route deletion retains the hostname and local row for retry. No catch-all or customer entries in Wrangler are needed, and existing routes remain in place. Production EU code deployment uses `wrangler versions upload` followed by deployment of the exact Version ID returned by the upload, preserving API-managed routes. Ordinary `wrangler deploy` replaces routes for the Worker, so do not use it or `wrangler triggers deploy` on production EU without preserving customer routes. Apply intentional static routing changes through the Cloudflare dashboard.

Verify provisioning and the `/updates`, `/stats`, and `/channel_self` endpoints with a test hostname before rollout; hostname and TLS activation alone do not verify Worker availability. DNS-only CNAME records are recommended for customers using Cloudflare unless their SaaS zone has an explicit orange-to-orange configuration.

Reference: [Workers Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/), [Cloudflare Worker as fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/) and [custom hostname API](https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/).

## Data and permissions

The service-managed `org_custom_domains` table has a primary key on `org_id` and unique indexes on hostname, provider hostname ID, and Worker route ID. Direct anonymous/authenticated access is denied for every operation. API requests require `org.update_settings`; only creation additionally requires an active Enterprise plan with a recorded payment (`paid_at`) and no overdue balance (`past_due_at`), so downgraded organizations can remove their domain. Creation and deletion serialize using an indexed organization row lock. No plugin hot-path database lookups or new cron jobs are introduced.

An organization with a saved domain gets HTTP 409 when adding another; a hostname reserved by another organization also returns 409. Existing manually configured Cloudflare hostnames remain untouched and are not automatically imported. If Cloudflare rejects creation of an existing hostname, the API returns a provider error and rolls back its local reservation; support must verify ownership before migrating that hostname.

Remove the custom domain before deleting its organization. Remove operations delete the Worker route and provider hostname before deleting the local row; a failed provider deletion keeps the row so it can be retried. Creation rolls back and attempts provider cleanup if persistence fails. If a provider create request times out after Cloudflare accepts it, support must reconcile the hostname and its Worker route in Cloudflare before retrying; do not adopt an existing provider hostname without verifying ownership.

Existing native installs keep using their configured URLs. Before removing a domain, ship a new native build using replacement endpoints and allow users to migrate. Certificate/hostname activation confirms Cloudflare provisioning; use a native test build to verify update, statistics, and channel behavior before production rollout. Regional residency and bundle delivery domains still require support coordination.
