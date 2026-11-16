# Cloudflare Snippets deployment

All three production snippets on `capgo.app` are managed by the catalog in
`scripts/snippet/catalog.ts`:

| Snippet | Source |
| --- | --- |
| `plugin_load_balancer` | `cloudflare_workers/snippet/index.js` |
| `legacy_cli_manifest_warning` | `cloudflare_workers/legacy_cli_manifest_warning/index.js` |
| `inbox_message` | `cloudflare_workers/inbox_message/index.js` |

The two existing compatibility snippet sources match the deployed behavior. The
load balancer builds from the existing readable source, including the cache
isolation checks for responses served from KV.

## Release path

After merge to `main`, the normal release test gate creates a stable `capgo-*`
tag. The **Deploy Cloudflare snippets** job in `build_and_deploy.yml` checks out
that release's resolved immutable SHA and runs after the database, API, files,
regional plugin and GoTrue jobs succeed (or are skipped because unchanged).
Alpha releases never publish snippets to the production zone.

Every stable release reconciles the entire catalog, including releases that do
not touch snippet files. This also recovers a missed or partially failed snippet
rollout in the next release. Identical modules are skipped. Each module is built
from source, minified to ESM, checked against the 32 KiB limit, uploaded, and read
back to verify its exact content. The uploader stops on an API error or mismatch;
it does not hide partial failures. Re-run **all jobs** of the appropriate release
workflow to retry, following the repository's deployment retry contract.

The job uses the existing `CLOUDFLARE_API_TOKEN` repository secret. That Cloudflare
token needs **Zone → Snippets → Edit** for `capgo.app`. No additional secret or
third-party deployment action is required. Builds use Bun without installing
project dependencies.

## Routing and inventory

This job updates **code only**. It never writes or deletes the zone's snippet
rules, changes rule order or enablement, or deletes a snippet. Existing rule
expressions contain private custom hostnames and must not be copied to this
public repository or CI logs. Routing is compared before and after deployment;
concurrent changes cause the job to fail for inspection.

Before uploading anything, the deployer verifies that the complete live snippet
inventory matches the catalog, every snippet has a routing rule (disabled rules
are preserved), and all live modules can be read. Unexpected, missing, or
multi-module snippets fail preflight instead of being silently ignored or
clobbered. Reconcile deliberate dashboard/probe changes before the next release.

To add a new snippet, commit its source and catalog entry, provision its initial
snippet and scoped routing rule through the normal reviewed operational process,
and run the read-only check below before the release. GoTrue route activation is
a separate change; this PR does not route authentication traffic to GoTrue.

## Validation

```sh
bun run build:snippets
bunx vitest run tests/snippet-deployment.unit.test.ts tests/cloudflare-snippet.unit.test.ts
# Uses CLOUDFLARE_API_TOKEN; reads production, makes no changes:
bun run check:snippets:live
```

`bun run deploy:snippets` is the mutating CI entrypoint; do not run it locally to
bypass the release gate. The older `build:snippet` / `check:snippet` commands and
tracked `index.min.js` remain available for the load balancer's existing checks,
but CI deployment builds fresh code from source rather than uploading that file.

API reference: <https://developers.cloudflare.com/rules/snippets/create-api/>.
