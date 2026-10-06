# Organization custom domains

Enterprise organizations can manage one Live Updates API hostname in Organization settings. The private API provisions a Cloudflare for SaaS hostname and returns DNS ownership and certificate validation records. Refresh fetches live provider status; updater URLs are offered only when both the hostname and TLS certificate are active. Bundle download URLs are unchanged.

## Existing Cloudflare setup

Reuse the existing Cloudflare for SaaS fallback on the `capgo.app` zone. Customers point their CNAME to `plugin.capgo.app`. The API looks up the zone by name using the existing `CF_ANALYTICS_TOKEN`; no new environment variables or token are required.

Add Zone Read and SSL and Certificates write permissions for `capgo.app` to that token. Deploy the shared plugin routes for `/updates`, `/stats`, and `/channel_self`, then verify provisioning and routing with a test hostname. New customer hostnames require no individual Wrangler edits. Existing explicit routes remain in place. DNS-only CNAME records are recommended for customers using Cloudflare unless their SaaS zone has an explicit orange-to-orange configuration.

Reference: [Cloudflare Worker as fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/) and [custom hostname API](https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/).

## Data and permissions

The service-managed `org_custom_domains` table has a primary key on `org_id` and unique indexes on hostname and provider ID. Direct anonymous/authenticated access is denied for every operation. API requests require `org.update_settings`; only creation additionally requires an active Enterprise plan, so downgraded organizations can remove their domain. Creation and deletion serialize using an indexed organization row lock. No plugin hot-path database lookups or new cron jobs are introduced.

Remove the custom domain before deleting its organization. Remove operations delete the provider hostname before deleting the local row; a failed provider deletion keeps the row so it can be retried. Creation rolls back and attempts provider cleanup if persistence fails. If a provider create request times out after Cloudflare accepts it, support must reconcile the hostname in Cloudflare before retrying; do not adopt an existing provider hostname without verifying ownership.

Existing native installs keep using their configured URLs. Before removing a domain, ship a new native build using replacement endpoints and allow users to migrate. Certificate/hostname activation confirms Cloudflare provisioning; use a native test build to verify update, statistics, and channel behavior before production rollout. Regional residency and bundle delivery domains still require support coordination.
