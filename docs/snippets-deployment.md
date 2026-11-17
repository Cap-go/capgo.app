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
token needs **Zone → Snippets → Edit** for `capgo.app`. Snippet deployment needs
no production database inventory or Supabase credential. No new secret or
third-party deployment action is required. Builds use Bun without installing
project dependencies.

## Custom-domain routing

All SaaS custom hostnames in the `capgo.app` zone, including manually configured
and future hostnames, serve the Live Updates API. This zone-wide product invariant
is required by the stable routing branch in `scripts/snippet/custom-domains.ts`.
Do not onboard unrelated SaaS applications to this zone without revisiting it.
The predicate selects foreign request hostnames, excluding `capgo.app`, all its
subdomains, `workers.dev` and its subdomains. Exclusions ignore case and trailing
DNS root dots using `lower(trim_end(http.host, "."))`. The native exclusions also keep
regional Worker subrequests from being selected again by the added branch.

The added branch matches only these exact paths:

- `/updates`, `/stats`, `/channel_self`, `/updates/manifest_size`
- `/plugin/updates`, `/plugin/stats`, `/plugin/channel_self`, `/plugin/updates/manifest_size`

The `/plugin/...` aliases and manifest-size endpoint are existing public Worker
routes. No prefix wildcard is used. Trailing slashes, arbitrary descendants,
health checks, serving-policy reads, cache-purge calls, files, auth, dashboard,
and internal API paths are excluded from the added branch. Query strings do not
change path matching. There is no method filter: POST, channel GET/PUT/DELETE,
HEAD and CORS OPTIONS reach the same snippet, and the Worker retains its existing
method validation.

After verifying every code upload, the normal release appends the stable branch
to the enabled `plugin_load_balancer` rule if it is missing. The original
expression is retained verbatim, including canonical routing and manual hostname
alternatives. These retained branches may intentionally match more paths than
the new branch. The combined expression must fit Cloudflare's 4,096-character
limit; deployment fails before writing if it does not. Existing alternatives
are not pruned or adopted as managed state.

Subsequent releases skip the rule write when that unconditional branch is present.
Adding or removing a custom hostname needs no `snippet_rules` write and no snippet
release. The custom-domain API still creates the SaaS hostname and its Worker
route synchronously. The stable predicate does not provision DNS, TLS, hostnames
or Worker routes, and it does not authorize arbitrary hosts outside this zone.

### Release constraints

The Cloudflare rules API replaces the entire list. When the stable branch must be
installed or repaired, the release sends every current rule in its original
order, preserving descriptions and enablement and changing only the plugin
expression. It rechecks for concurrent changes immediately before the write and
reads back all rules afterward. These checks are **not compare-and-swap**: a
concurrent write between the final GET and PUT can still be overwritten, and
successful readback cannot detect a lost edit. Coordinate exclusive snippet-rule
editing during that release window. Domain creation/removal never writes this
list. There is no automatic rollback that could overwrite another edit.

Module uploads and the rules update are separate provider operations, not an
atomic transaction. Upload or readback failures can leave a partial release;
routing is updated only after all module content checks succeed. Existing
release gates, inventory checks and retry constraints still apply.

Cloudflare evaluates snippet rules in the serving zone against the original
request hostname and URI path. With O2O, customer-zone settings apply first and
provider-zone settings second; `cf-connecting-o2o` is per-request behavior, not a
hostname ownership signal. The predicate does not depend on that header or a
CNAME target. This change does not alter O2O, DNS or Worker-route configuration.
Local expression and provider-fake tests do not prove live provider acceptance
or every O2O setup. Validate DNS-only and any supported O2O configuration with a
test hostname during the normal authorized rollout, including each endpoint and
channel method. No production probe or activation is part of this code change.

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
# Uses CLOUDFLARE_API_TOKEN:
# Reads production code and rules; reports the routing plan without changes.
bun run check:snippets:live
```

`bun run deploy:snippets` is the mutating CI entrypoint; do not run it locally to
bypass the release gate. The older `build:snippet` / `check:snippet` commands and
tracked `index.min.js` remain available for the load balancer's existing checks,
but CI deployment builds fresh code from source rather than uploading that file.

API reference: <https://developers.cloudflare.com/rules/snippets/create-api/>.
Rules semantics: [snippet evaluation](https://developers.cloudflare.com/rules/snippets/how-it-works/),
[operators](https://developers.cloudflare.com/ruleset-engine/rules-language/operators/),
[functions](https://developers.cloudflare.com/ruleset-engine/rules-language/functions/),
[original request hostname](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.host/),
[request path](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.uri.path/),
[O2O](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/).
Primary documentation checked on 2026-11-17.
