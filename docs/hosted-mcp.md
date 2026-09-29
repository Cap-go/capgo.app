# Hosted Capgo MCP server

Capgo exposes a remote MCP server at `https://api.capgo.app/mcp`. You can add it to web tools such as Lovable, Claude.ai, ChatGPT, Cursor, VS Code or MCP Inspector by URL. Nothing needs to be installed.

The local server (`npx @capgo/cli@latest mcp`) still exists. Use it for tasks that need the local project, such as uploading bundle files, requesting native builds, `doctor` and `probe`.

## Connecting a client

| Client supports | What to enter |
| --- | --- |
| OAuth (Claude, ChatGPT, Cursor, VS Code, Lovable "OAuth") | The URL `https://api.capgo.app/mcp`. The client discovers login on its own. |
| Bearer / API key header (Lovable "API key", n8n, scripts) | The URL, plus the header `Authorization: Bearer <Capgo API key>` |

## Login flow (MCP authorization spec 2025-11-25)

1. The client calls `POST /mcp` without a token. The server answers `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. The client reads the protected resource metadata (RFC 9728), then the authorization server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`.
3. The client identifies itself in one of two ways:
   - dynamic client registration (RFC 7591) at `/mcp/oauth/register`, or
   - a Client ID Metadata Document URL used as its `client_id`.

   Only public clients are supported (`token_endpoint_auth_method: none`), and PKCE `S256` is required.
4. `/mcp/oauth/authorize` validates `client_id` and `redirect_uri`, then stores a pending request in `mcp_oauth_requests`.
5. It redirects to the console page `/oauth/authorize?request=<id>`. The normal console login applies there: SSO, 2FA and org password policies.
6. On the consent page, the user picks the organizations to share. The console then mints a dedicated API key named `MCP · <client>` through `POST /apikey`, the same way CLI login does. Because it goes through `POST /apikey`:
   - MFA is enforced,
   - the org rules on hashed and expiring keys apply,
   - RBAC bindings use the user's admin role in each organization.
7. `POST /private/mcp_oauth/approve` creates a single-use code that is valid for 60 seconds.
   - Only the SHA-256 hash of the code is stored.
   - The API key is stored encrypted with AES-GCM, using a key derived from the code, so a database dump alone cannot recover it.
8. The client exchanges the code and its `code_verifier` at `/mcp/oauth/token`. The `access_token` it receives is that API key. `expires_in` is set when an org policy makes the key expire.
9. To revoke access, delete the key on the API keys page or call `/mcp/oauth/revoke` (RFC 7009).

## Tools

The hosted server has about 50 tools. They cover:
- account and organizations, including members, audit logs and API keys,
- apps,
- bundles,
- channels and progressive rollouts,
- devices and channel overrides,
- statistics and Observe,
- build status, logs and cancel,
- webhooks,
- push notifications.

Each tool is a typed zod schema over an existing public API route. The route is replayed inside the API worker with the caller's API key, so RBAC, rate limits and audit logs behave exactly like the REST API.

Tool annotations tell clients how careful to be:
- `readOnlyHint` marks tools that only read data.
- `destructiveHint` marks tools that delete data. Clients should ask the user for confirmation before calling them.

Code: `supabase/functions/_backend/mcp/` (transport, protocol, tools and OAuth) and `supabase/functions/_backend/private/mcp_oauth.ts` (consent API). The console page is `src/pages/oauth/authorize.vue`.
