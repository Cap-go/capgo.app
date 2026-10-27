# R2 lifecycle rules

This directory stores bucket-level R2 lifecycle configuration.

`lifecycle.capgo.json` defines the `capgo` bucket lifecycle rules:

- Delete objects under `deleted-after-7-days/` after 7 days. That prefix must stay aligned with `R2_TRASH_PREFIX` in `supabase/functions/_backend/utils/s3.ts`.
- Delete objects under `upload-sessions-expire-after-1-day/` after 1 day: staged bundle uploads from the hosted MCP upload sessions that were never completed or aborted. That prefix must stay aligned with `UPLOAD_STAGING_PREFIX` in `supabase/functions/_backend/public/bundle/upload_session.ts`.
- Abort incomplete multipart uploads after 1 day across the bucket.

Apply the tracked config:

```bash
bunx wrangler r2 bucket lifecycle set capgo --file cloudflare_workers/r2/lifecycle.capgo.json --force
```

Verify the rule:

```bash
bunx wrangler r2 bucket lifecycle list capgo
```

`lifecycle set` replaces the bucket lifecycle configuration. If the `capgo` bucket already has other lifecycle rules, add them to `lifecycle.capgo.json` before applying it.
