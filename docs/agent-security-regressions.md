# Agent security regressions (Capgo)

Checklist for coding agents working in Cap-go repositories. Grounded in **published and closed policy decisions**, not unpublished exploit detail.

Do **not** paste GHSA ids, unpublished advisory bodies, or embargoed PoCs into public PRs, issues, changelogs, or docs. Private crew-memory may reference GHSA ids when already in play.

Canonical researcher policy: [org SECURITY.md](https://github.com/Cap-go/.github/blob/main/SECURITY.md), https://capgo.app/security/, https://capgo.app/bug-bounty/.

## Known non-vulnerabilities (do not "fix")

- Unauthenticated `channel_self` SET and designed no-API-key `/updates` / `/stats` behavior are **intentional**. Do not open security-fix PRs for missing auth on those flows. See `AGENTS.md` Plugin endpoint security triage HARD RULE.
- Uploader mislabeling encryption on `external_url` bundles is **not** a Capgo vulnerability.

## Do not regress — authz / IDOR / BOLA

- Enforce org/app membership and role checks on every mutating and sensitive read path.
- Never trust client-supplied org id, app id, device id, or user id alone for authorization.
- Keep oracle/RPC hardening: anonymous callers must not learn other users' org membership or invite state via permissive EXECUTE grants.
- Limited API keys stay scoped. Do not widen key capabilities without an explicit product change and tests.

## Do not regress — OTA / channel / bundle

- Channel and bundle trust boundaries stay enforced on server and plugin paths that claim authenticity.
- When `publicKey` (E2E encryption) is configured, do not accept plaintext / empty `sessionKey` manifest updates as encrypted delivery.
- Manifest `file_name` / install paths must stay sandboxed (no `..` escape). Apply on iOS and Android.
- Updater `delete` / `set` / `next` id paths must stay constrained to the updater sandbox.

## Do not regress — injection

- Prefer parameterized SQL / RPC. No string-built queries from request input.
- Escape or avoid `eval` / WebView script injection from logger or update payloads.
- Treat HTML/markdown surfaces that render user or remote content as XSS-sensitive.

## Do not regress — path traversal / symlink (CLI heavy)

- When extracting or writing zip / bundle content, do not follow symlinks out of the intended root.
- Canonicalize destination paths and verify containment before write or delete.
- Project-controlled config (`localApi`, `localSupa`, app paths) is untrusted input for filesystem and network side effects.

## Do not regress — SSRF / info disclosure

- Webhook and fetch URLs need allowlists or equivalent controls. Do not fetch arbitrary attacker URLs from privileged workers.
- Error responses must not leak other tenants' data, secrets, or stack traces useful as oracles.

## Do not regress — SQL / SECURITY DEFINER

- Follow existing `AGENTS.md` Supabase / SECURITY DEFINER and `search_path` rules.
- Do not break already-published CLI RPC contracts when hardening grants (see published-CLI HARD RULE).

## Embargo

Until Charly/Martin approve public disclosure:

- No unpublished exploit steps in public repos.
- No GHSA ids in public PR titles, bodies, branch names, commit messages, issues, or changelogs (crew-memory private is fine).
- Prefer side-effect or intentional fix PRs without advertising the advisory.

## When unsure

Ask Charly (crew lead). Do not invent new out-of-scope policy. Mirror Pack 1 researcher language.
