# Native notifications operations

Native notifications use Cloudflare Analytics Engine for active device state and
events. Capgo Postgres stores only platform credential config, app settings, and campaign
metadata.

## Cloudflare queues

The API worker must have the notification queues created before deploy:

```bash
bun run deploy:cloudflare:notifications:queues
```

To create only one environment:

```bash
bun scripts/ensure-native-notification-queues.ts alpha
bun scripts/ensure-native-notification-queues.ts preprod
bun scripts/ensure-native-notification-queues.ts prod
```

The script creates the primary queue and dead-letter queue names referenced by
`cloudflare_workers/api/wrangler.jsonc`.

## Platform secrets

### Hosted Capgo

Customers upload platform credentials in the app **Notifications** tab:

- **iOS**: APNs auth key (`.p8` PEM file) plus `teamId`, `keyId`, and `bundleId` in config.
- **Android**: Firebase service account JSON file plus `projectId` in config.

Uploaded secrets are encrypted at rest in Postgres (`secret_ciphertext`). The API
never returns the private key after upload; the console shows only `has_secret`.

### Self-host / legacy worker env

Self-hosted deployments can keep using worker environment variables referenced by
`secret_ref` (for example `NOTIFICATIONS_COM_EXAMPLE_APP_IOS`). The dashboard
**Self-host / advanced** section exposes the expected env var name.

Configured Android push credentials require `projectId` in platform config. Configured iOS
push credentials require `teamId`, `keyId`, and `bundleId`.
