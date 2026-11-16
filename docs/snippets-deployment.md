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
token needs **Zone → Snippets → Edit** for `capgo.app`. It also uses the existing
`SUPABASE_TOKEN` and `SUPABASE_PROJECT_ID_PROD` secrets to read production custom
domains. No new secret or third-party deployment action is required. Builds use
Bun without installing project dependencies.

## Routing and inventory

Before uploading code, the job reads `public.org_custom_domains` from the
production primary database through the Supabase Management API with
`read_only: true`. A single bounded query returns only hostnames and a provisioning
flag. Invalid responses, incomplete registrations, or more than 1,000 domains
fail deployment before Cloudflare writes. No database changes are made.

After verifying every code upload, the job adds any missing database hostname as
an unconditional `http.host eq` alternative to the enabled `plugin_load_balancer`
rule. Existing manual hostnames and path predicates are retained. A hostname
mentioned only inside a conditional or negated expression does not count as full
coverage. The result must fit Cloudflare's 4,096-character expression limit.

The Cloudflare rules API replaces the entire list, so the job sends every current
rule in its original order, preserving descriptions and enablement and changing
only the plugin rule's expression. It rechecks for concurrent changes immediately
before the write and reads back all rules afterward. There is no automatic
rollback that could overwrite an operator's concurrent edit.

An empty database leaves routing unchanged. Removing a database registration does
not delete an existing rule alternative: legacy domains may have been provisioned
manually, so domain removal remains a deliberate operational change. This job
does not provision DNS, certificates, custom hostnames, or Worker routes; the
custom-domain API manages those resources.

Existing expressions and production hostnames stay in memory and must not be
copied to this public repository, artifacts, or CI logs. Output contains counts,
snippet names, and code hashes only. Provider error bodies are never logged.

Before uploading anything, the deployer verifies that the complete live snippet
inventory matches the catalog, every snippet has a routing rule, the plugin rule
is enabled and unique, and all live modules can be read. Other rules' disabled
states are preserved. Unexpected, missing, or
multi-module snippets fail preflight instead of being silently ignored or
clobbered. Reconcile deliberate dashboard/probe changes before the next release.

To add a new snippet, commit its source and catalog entry, provision its initial
snippet and scoped routing rule through the normal reviewed operational process,
and run the read-only check below before the release. GoTrue route activation is
a separate change; this PR does not route authentication traffic to GoTrue.

## Validation

```sh
bun run build:snippets
bunx vitest run tests/snippet-deployment.unit.test.ts tests/snippet-custom-domains.unit.test.ts tests/cloudflare-snippet.unit.test.ts
# Uses CLOUDFLARE_API_TOKEN, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_ID_PROD:
# Reads production code, rules, and database; makes no changes.
bun run check:snippets:live
```

`bun run deploy:snippets` is the mutating CI entrypoint; do not run it locally to
bypass the release gate. The older `build:snippet` / `check:snippet` commands and
tracked `index.min.js` remain available for the load balancer's existing checks,
but CI deployment builds fresh code from source rather than uploading that file.

API reference: <https://developers.cloudflare.com/rules/snippets/create-api/>.
Read-only query: <https://supabase.com/docs/reference/api/v1-run-a-query>.
