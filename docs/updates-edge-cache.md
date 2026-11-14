# /updates edge cache purge

Capgo caches plugin `/updates` responses at the edge under a per-app Cache-Tag:

`capgo-updates-<app_id>` (sanitized lowercase).

Cache entries typically live about one hour. After you change channels, bundles, or app settings, devices should receive fresh data automatically when the backend purge pipeline runs.

## Manual purge in the console

On **App settings**, users with app write or admin rights can click **Purge edge cache**. That calls `POST /private/purge_updates_edge_cache` with `{ "app_id": "..." }`, which runs `purgeAppUpdatesCache(app_id)`: enqueue the app's `capgo-updates` tag, then nudge the shared `claim` / `purgeUpdatesCacheTags` / `ack` drain (same path as `triggers/updates_cache_purge`).

**Depends on [#4118](https://github.com/Cap-go/capgo.app/pull/4118)** for trigger-side `purgeUpdatesCache` hooks. After #4118 merges, rebase this branch onto `main` and collapse `purgeAppUpdatesCache.ts` into Teo's helper if the export moves there.

Rate limit: once per minute per app.

## Automatic purge

Database statement triggers enqueue scoped purges (`app` and `versions`) and wake `triggers/updates_cache_purge`. Queue handlers can nudge the shared drain via `purgeUpdatesCache()` in `supabase/functions/_backend/utils/purgeUpdatesCache.ts` (see PR #4118).