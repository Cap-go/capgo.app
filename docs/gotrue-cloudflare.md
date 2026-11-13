# Self-hosted GoTrue on Cloudflare (auth migration, PR 2)

GoTrue v2.197.0 (the release hosted Supabase Auth runs for our project) in a
Cloudflare container, on the production database in schema `auth_cf` as role
`gotrue_cf`. Customers stay on hosted Supabase Auth: the GoTrue Worker has no
route, and only the API's `local_gotrue` environment binds it. Routing the
console and `sb.capgo.app` to it is PR 3.

```
console → API relay /private/console/auth/* → GOTRUE service binding
        → capgo_gotrue-prod Worker → GoTrue Durable Object (weur) → container (WEUR)
        → Postgres (auth_cf, as gotrue_cf)
```

- Worker: `cloudflare_workers/gotrue/` (Dockerfile, `index.ts`, `wrangler.jsonc`).
- Non-secret settings: `vars` in `cloudflare_workers/gotrue/wrangler.jsonc`, mirroring the hosted Auth config.
- Relay: `supabase/functions/_backend/private/console_auth_proxy.ts` sends to GoTrue when the `GOTRUE` binding exists, otherwise to hosted Supabase (unchanged).
- Grants: `supabase/migrations/20261112230000_gotrue_cf_auth_hooks.sql` lets `gotrue_cf` call the two Postgres auth hooks.

GoTrue reads its database namespace from `DB_NAMESPACE` (not `GOTRUE_DB_NAMESPACE`).
With the wrong name it silently uses `auth`.

## Secrets

### Turnstile (`CAPTCHA_SECRET_KEY` Secrets Store)

The GoTrue Worker binds `CAPTCHA_SECRET_KEY` from the account `default_secrets_store`
(`cloudflare_workers/gotrue/wrangler.jsonc`). It must be the same Turnstile secret the
API Worker uses (`CAPTCHA_SECRET_KEY` / `CLOUDFLARE_TURNSTILE_SECRET_KEY` on
`capgo_api-prod`). Do not push a copy with `deploy:cloudflare_env:gotrue:prod`.

Before first deploy, create or confirm the `CAPTCHA_SECRET_KEY` store secret (workers scope)
if it is not there yet. The container maps it to `GOTRUE_SECURITY_CAPTCHA_SECRET`.

### `internal/cloudflare_gotrue_auth/.env.prod`

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
The CI token needs Containers write, Cloudchamber write, and Account Secrets Store Edit permissions.

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
