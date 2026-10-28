# Alert tail worker

Forwards Cloudflare Worker execution errors to an external alert webhook using [Tail Workers](https://developers.cloudflare.com/workers/observability/logging/tail-workers/).

Producer workers (`capgo_api-prod`, `capgo_files-prod`, regional `capgo_plugin-*-prod`) send tail events to this worker via `tail_consumers` in their Wrangler config.

## Secrets

Set on the tail worker (not on producers):

```bash
bunx wrangler secret put ALERT_WEBHOOK_URL --config cloudflare_workers/alert_tail/wrangler.jsonc --env=prod
bunx wrangler secret put ALERT_WEBHOOK_AUTH --config cloudflare_workers/alert_tail/wrangler.jsonc --env=prod
```

- `ALERT_WEBHOOK_URL`: full HTTPS URL for the alert ingest endpoint
- `ALERT_WEBHOOK_AUTH`: value sent as the `Authorization` request header (for example a bearer token)

If either secret is missing, the tail handler no-ops.

## Deploy

```bash
bun run deploy:cloudflare:alert_tail:prod
```

Deploy the tail worker before redeploying producers that reference it in `tail_consumers`.

## Payload

Each POST body is JSON `{ "alerts": [ ... ] }`. Entries include `functionName`, `errorName`, `message`, `stack` (max 4KB), HTTP metadata, `count` (deduped within the tail batch), and `body: null`.
