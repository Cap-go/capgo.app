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

The dashboard stores only platform metadata and the expected secret reference.
The private Android or iOS push credential must be present in the API worker environment
under the exact name shown in the app Notifications tab before a platform is
marked configured.

Configured Android push credentials require `projectId` in platform config. Configured iOS
push credentials require `teamId`, `keyId`, and `bundleId`.
