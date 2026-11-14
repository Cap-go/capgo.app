# /updates edge cache purge

Capgo caches plugin `/updates` responses at the edge under a per-app Cache-Tag:

`capgo-updates-<app_id>` (sanitized lowercase).

Cache entries typically live about one hour. After you change channels, bundles, or app settings, devices should receive fresh data automatically when the backend purge pipeline runs.

## Manual purge in the console

On **App settings**, users with app write or admin rights can click **Purge edge cache**. That calls `POST /private/purge_updates_edge_cache` with `{ "app_id": "..." }`, which runs `purgeAppUpdatesCache(app_id)`: enqueue the app's `capgo-updates` tag, then nudge the shared `claim` / `purgeUpdatesCacheTags` / `ack` drain (same path as `triggers/updates_cache_purge`).

Console and trigger paths share `purgeAppUpdatesCache` in `supabase/functions/_backend/utils/purgeUpdatesCache.ts` (from [#4118](https://github.com/Cap-go/capgo.app/pull/4118)).

Rate limit: once per minute per app.

## Automatic purge

Database statement triggers enqueue scoped purges (`app` and `versions`) and wake `triggers/updates_cache_purge`. Queue handlers can nudge the shared drain via `purgeUpdatesCache()` in `supabase/functions/_backend/utils/purgeUpdatesCache.ts` (see PR #4118).