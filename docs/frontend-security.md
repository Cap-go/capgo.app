# Frontend security operations

Capgo ships browser security controls in the console web app. This note covers
**process only** — not automated penetration testing.

## What is enforced in code

- **CSP** — `scripts/console-security-policy.ts` is the source of truth for the
  console policy. Sync it into `public/_headers` with
  `bun run security:sync-headers` before merging CSP changes.
- **SRI** — `bun run security:compute-integrity` hashes real remote bytes for
  any pinned third-party asset. Never hand-edit `integrity="..."` attributes.
- **Sanitization / redirects** — `src/utils/sanitize.ts` and
  `src/utils/safeRedirect.ts` centralize HTML sanitization and in-app redirect
  validation.

## Routine review checklist

1. Re-run `bun run security:sync-headers` after editing the CSP module and
   confirm `tests/security-headers.unit.test.ts` still passes.
2. When a CDN asset changes (fonts, analytics, Turnstile, PostHog proxy), run
   `bun run security:compute-integrity` and update any pinned tags or
   self-hosted copies.
3. Audit new frontend sinks: `v-html`, `innerHTML`, unsanitized query params,
   and `window.location` / `router.replace` targets.
4. Schedule periodic dependency and configuration reviews (CSP allowlists, SRI
   inventory, auth redirect paths) with normal release/security audits.

## Known residual risks (document, do not hide)

- `index.html` includes a small inline theme bootstrap script. CSP keeps
  `'unsafe-inline'` for `script-src` until a nonce/hash migration is justified.
- PostHog and Cloudflare Turnstile load vendor scripts from their CDNs without
  SRI because the files are not byte-stable. They remain explicit CSP
  allowlist entries.
