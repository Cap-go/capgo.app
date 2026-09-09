# JWT Authentication for App Updates

## Goal

Allow signed-in console users to call `PUT /app/:appId` with their Supabase JWT while preserving every existing API-key and subkey caller, including published CLI versions and self-hosted CLI requests that send both a project bearer token and `capgkey`.

## Scope

This first PR changes only authentication and authenticated database-client selection for the existing app update endpoint. It does not change the request body, authorization permissions, onboarding merge behavior, the frontend caller, or any onboarding RPC.

## Design

The route will use the existing dual-auth `middlewareAuth()` middleware with a route-scoped option that prefers an explicit `capgkey` over `Authorization`. This preserves self-hosted CLI requests whose `Authorization` header contains the Supabase project token without changing authentication precedence on unrelated endpoints. Without `capgkey`, a UUID-shaped raw `Authorization` value remains an API key and a bearer/raw JWT remains a JWT.

The app update handler will use `c.get('auth')` and `supabaseWithAuth()` rather than assuming `c.get('apikey')` exists. API-key and subkey contexts continue to create an API-key-scoped Supabase client. JWT contexts create a user-JWT Supabase client, so existing RLS and `checkPermission()` checks remain authoritative. Narrow onboarding-only writes that already run through explicit authorization and direct PostgreSQL keep their current behavior.

## Compatibility and security

- Existing API-key callers keep the same route and response contract.
- Existing subkey callers retain their subkey auth context and RLS scope.
- Published CLI requests with a raw UUID in `Authorization` continue to authenticate as API keys.
- Self-hosted CLI requests with `Authorization: Bearer <project key>` plus `capgkey` authenticate with `capgkey`.
- JWT callers receive no broader authorization: `app.update_settings` and the existing narrow onboarding permissions are unchanged.
- Invalid or unauthorized JWT callers continue to receive an authorization error.

## Verification

Integration coverage will prove JWT settings/onboarding updates, denied JWT updates, API-key compatibility, subkey compatibility, and explicit `capgkey` precedence. The final branch will run backend lint, the focused app API tests, the published CLI compatibility contract, and the repository PR-readiness workflow.
