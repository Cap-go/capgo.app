# Self-hosted GoTrue on Cloudflare (auth migration, PR 2)

GoTrue v2.198.0 (the release hosted Supabase Auth runs for our project) in a
Cloudflare container, on the production database in schema `auth_cf` as role
`gotrue_cf`. The GoTrue Worker has no route: the production API binds it, and
`sb.capgo.app/auth/v1/*` reaches it through the API relay (see Cutover).

```
console → API relay /private/console/auth/* → GOTRUE service binding
        → capgo_gotrue-prod Worker → GoTrue Durable Object (weur) → container (WEUR)
        → Postgres (auth_cf, as gotrue_cf)
```

- Worker: `cloudflare_workers/gotrue/` (Dockerfile, `index.ts`, `wrangler.jsonc`).
- Non-secret settings: `vars` in `cloudflare_workers/gotrue/wrangler.jsonc`, mirroring the hosted Auth config.
- Relay: `supabase/functions/_backend/private/console_auth_proxy.ts` sends to GoTrue when the `GOTRUE` binding exists, otherwise to hosted Supabase (unchanged).
- Grants: `supabase/migrations/20261113163729_gotrue_cf_auth_hooks.sql` lets `gotrue_cf` call the two Postgres auth hooks.

GoTrue reads its database namespace from `DB_NAMESPACE` (not `GOTRUE_DB_NAMESPACE`).
With the wrong name it silently uses `auth`.

## Secrets: `internal/cloudflare_gotrue_auth/.env.prod`

Capgo does not use Cloudflare Secrets Store for now (Martin, 2026-11-13), so the
Turnstile secret is a copy on this Worker, like the others.

Not in the repository yet. Encrypt it with git-secret like `internal/cloudflare/`,
then push it with `bun run deploy:cloudflare_env:gotrue:prod`.

- `DATABASE_URL`: Supavisor session mode,
  `postgres://gotrue_cf.<project-ref>:<password>@<pooler-host>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/certs/supabase-ca.crt`.
  Copy the pooler host from the dashboard's Connect dialog. Transaction mode (6543)
  breaks GoTrue's prepared statements.
- `GOTRUE_JWT_SECRET`: hosted Auth HS256 secret, required by GoTrue.
- `GOTRUE_JWT_KEYS`: JSON array with the ES256 private JWK (`kid` = the standby key
  in the hosted JWKS), so the API accepts our tokens.
- `GOTRUE_SAML_PRIVATE_KEY`: base64 DER RSA private key.
- `GOTRUE_SECURITY_CAPTCHA_SECRET`: the Turnstile secret, same value as
  `CAPTCHA_SECRET_KEY` on `capgo_api-prod` (the console's widget issues the tokens).
- `SUPABASE_SERVICE_ROLE_KEY`: the same `sb_secret_` key as `capgo_api-prod`. It is not a
  JWT, so GoTrue would refuse it. When a request carries it (`apikey` or `Authorization`),
  the Worker drops it and sends a 5-minute `service_role` token signed with the
  `GOTRUE_JWT_KEYS` signing key instead, like Supabase's gateway does for hosted Auth
  (`service_key.ts`). ES256 because, once `GOTRUE_JWT_KEYS` is set, GoTrue accepts only
  its algorithms. GoTrue itself never receives this secret. Without it, nothing is swapped.

Rotate `GOTRUE_JWT_KEYS` in two pushes. The Worker signs with the new `sign` key at once,
but the container reads its environment only when it starts and refuses a `kid` it
doesn't hold, so it must know the new key before the Worker signs with it:

1. Add the new JWK with `key_ops: ["verify"]` (the old key keeps `sign`), push, and
   confirm the container restarted with it (it verifies both `kid`s). Also confirm the new
   `kid` is in the hosted JWKS, or the API will refuse tokens GoTrue signs after step 2.
2. Move `sign` to the new key (the old one becomes `verify`), push, and restart again.

Before GoTrue first connects, change the `gotrue_cf` password from the Supabase
SQL editor with a SCRAM verifier, never the plaintext (statements are logged):
`ALTER ROLE gotrue_cf PASSWORD 'SCRAM-SHA-256$...';`

## Local run

Needs Docker and a running local Supabase (`bun run supabase:start`).

1. Give `gotrue_cf` a local password:
   `docker exec <supabase_db container> psql -U postgres -c "alter role gotrue_cf password 'local-only'"`
2. Create `cloudflare_workers/gotrue/.dev.vars` (git-ignored):
   ```
   DATABASE_URL=postgres://gotrue_cf:local-only@host.docker.internal:<db port>/postgres?sslmode=disable
   GOTRUE_JWT_SECRET=local-only-jwt-secret-at-least-32-characters
   GOTRUE_SECURITY_CAPTCHA_ENABLED=false
   GOTRUE_RATE_LIMIT_EMAIL_SENT=100
   GOTRUE_SAML_PRIVATE_KEY=<openssl genrsa 2048 | openssl rsa -traditional -outform DER | base64>
   # Optional, for admin calls with the service key: a local P-256 JWK with "kid" and key_ops ["sign","verify"].
   GOTRUE_JWT_KEYS=[{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"...","kid":"local","alg":"ES256","key_ops":["sign","verify"]}]
   SUPABASE_SERVICE_ROLE_KEY=sb_secret_local-only
   ```
3. `cd cloudflare_workers/gotrue && bunx wrangler dev --port 8790`
4. `cd cloudflare_workers/api && bunx wrangler dev --env=local_gotrue --local --port 8787`
5. Call `http://localhost:8787/private/console/auth/health`.

The first request starts the container, which runs GoTrue's migrations into `auth_cf`.
A container keeps its environment until it restarts: after changing `vars` or
`.dev.vars`, restart `wrangler dev` and remove the old `workerd-capgo_gotrue-prod-*` containers.

### Flows checked locally (2026-11-11)

All through `http://localhost:8787/private/console/auth`:

- `health`, `.well-known/jwks.json`, `sso/saml/metadata`
- sign-up, password login, `user`, refresh, logout (then `session_not_found`); users land in `auth_cf`, not `auth`
- TOTP: `factors`, `factors/<id>/challenge`, `factors/<id>/verify` (token reaches `aal2`)
- magic link: `otp` runs the `hook_send_email` Postgres hook as `gotrue_cf`; `verify` redirects with a session
- SAML with [mock-saml](https://github.com/boxyhq/mock-saml) in Docker: register it through GoTrue's admin API (call the GoTrue Worker on port 8790 directly with a local `service_role` token, since the relay never relays `admin/*`), start with `POST sso`, post the IdP form to `sso/saml/acs`; GoTrue redirects with a session

## After merge: deploy and test against production

CI deploys `capgo_gotrue-prod` on production releases that touch `cloudflare_workers/gotrue/`.
The CI token needs Containers write and Cloudchamber write permissions.

1. Change the `gotrue_cf` password (see above), then fill and push `internal/cloudflare_gotrue_auth/.env.prod`.
2. Run the API locally against the deployed Worker (needs `wrangler login` with Workers rights):
   `cd cloudflare_workers/api && bunx wrangler dev --env=local_gotrue --port 8787` (no `--local`).
3. Run the console with auth on the local relay and data on the production API:
   `VITE_AUTH_API_HOST=http://localhost:8787 bun serve:prod-no-cors`
4. Check `health` (starts the container, migrates `auth_cf`, proves `verify-full` through the pooler),
   then sign-up, login, refresh, logout, TOTP, a magic link and a test SSO.
   Email links point at hosted Supabase: replace their host and path with
   `http://localhost:8787/private/console/auth/verify?...` by hand.
5. Confirm the production API accepts the tokens (console data loads).

## Cutover (PR 3)

The cutover PR moves production onto this GoTrue in one release:

- Migration `auth_cf_cutover`:
  - copies users, identities, MFA factors, SSO providers and pending email tokens from
    `auth` to `auth_cf`, keeping ids (sessions are not copied: everyone signs in again);
  - points the `public` foreign keys and the two Capgo auth triggers at `auth_cf`;
  - rewrites every `public` function that read `auth.*` tables to read `auth_cf`.
  Where GoTrue never ran (local dev, CI, self-hosting), `auth_cf` gets views of `auth`
  instead, so the same SQL works. Running our GoTrue against a local database therefore
  needs those views dropped first.
- `capgo_api-prod` gets the `GOTRUE` binding: the console relay, admin calls, SSO provider
  management and JWT checks go to this GoTrue, and the API only trusts its JWKS, so tokens
  issued by hosted Auth are refused.
- `API_EXTERNAL_URL` becomes `https://sb.capgo.app/auth/v1`: email links and the SAML
  entity ID and ACS URL stay the ones customers already use.

Run it in a low-traffic slot. Between the migration and step 2, a sign-up on hosted Auth
can fail and a password change there is lost.

1. Before merging: push `SUPABASE_SERVICE_ROLE_KEY` to `capgo_gotrue-prod` (see Secrets).
2. Right after the deploy: turn on the `sb.capgo.app` snippet
   `cloudflare_workers/gotrue_auth_relay/index.js` (rule in its header): `/auth/v1/*` goes to
   `https://api.capgo.app/private/console/auth/*` (same method, query and body).
3. Catch-up for rows written on hosted Auth in between, from the SQL editor:
   `SELECT public.copy_auth_to_auth_cf(false);` (adds only the accounts and SSO providers
   created on hosted Auth since the copy, with their own rows; changes nothing else).
4. Hosted Auth dashboard: turn off new sign-ups.
5. Check: row counts of `auth` vs `auth_cf` (users, identities, mfa_factors, sso_providers),
   login with TOTP, a password reset link from the email, one SSO login per provider, and a
   token from hosted Auth (`kid` other than ours) refused by the API.

The legacy Supabase Edge Functions still verify tokens against the hosted JWKS, so keep
our key there until they are deleted.
