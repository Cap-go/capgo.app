# Hosted Capgo MCP server

Capgo exposes a remote MCP server at `https://mcp.capgo.app/` (`https://api.capgo.app/mcp` still works for existing clients). You can add it to web tools such as Lovable, Claude.ai, ChatGPT, Cursor, VS Code or MCP Inspector by URL. Nothing needs to be installed.

The local server (`npx @capgo/cli@latest mcp`) still exists. Use it for tasks that need the local project, such as uploading bundle files, requesting native builds, `doctor` and `probe`.

## Connecting a client

| Client supports | What to enter |
| --- | --- |
| OAuth (Claude, ChatGPT, Cursor, VS Code, Lovable "OAuth") | The URL `https://mcp.capgo.app/` or `https://mcp.capgo.app/mcp`. The client discovers login on its own. |
| Bearer / API key header (Lovable "API key", n8n, scripts) | The URL, plus the header `Authorization: Bearer <Capgo API key>` |

## Public setup and discovery

Opening `https://mcp.capgo.app/` or `https://api.capgo.app/mcp` in a browser shows setup instructions without signing in. Requests preferring JSON or an SSE stream still receive `405`; authenticated MCP calls use `POST`.

The API host also publishes public, cacheable discovery documents:

- `/mcp/server-card`: the [SEP-2127 Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards), with the `application/mcp-server-card+json` media type. `/.well-known/mcp/server-card.json` serves the same card for older scanners.
- `/.well-known/ai-catalog.json`: an AI Catalog pointing to the card.
- `/.well-known/mcp.json` and `/mcp.json`: MCP Registry manifests declaring the remote endpoint.

The card, `server/discover` and legacy `initialize` share the server identity `app.capgo/capgo` and version. The card lists both modern and legacy protocol versions. Cards contain public connection metadata only; tools, resources and skills are listed through authenticated MCP requests. Discovery uses the configured canonical API origin, like OAuth protected-resource metadata, and supports ETag revalidation.

## Skills

The hosted server publishes seven public workflow guides from this repository: `check-update-health`, `ship-live-update`, `native-builds`, `observe`, `organization-management`, `release-management` and `usage`.

For clients using ordinary MCP tools:

1. Call `capgo_list_skills` to get names, descriptions, skill URIs and file manifests without loading the instructions.
2. Call `capgo_get_skill` with a returned `uri` to read its `SKILL.md`. To read a supporting file, also pass its `resourceUri` from that skill's manifest.

Both tools return text and matching structured content with an output schema. The same files are available through `resources/list` and `resources/read` on legacy clients. CLI guides require a local shell and project files; the hosted server does not execute their commands. Reading a guide does not grant permission to perform its actions, and existing confirmation and access controls still apply. Whether a client automatically discovers and activates skills depends on its own support.

### Standard Skills extension

For MCP `2026-07-28` clients, `server/discover` declares `resources` and the beta [`io.modelcontextprotocol/skills` extension](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills):

- `skills/list` returns all seven entries in one page, without file contents. Each entry contains the original YAML frontmatter as JSON and a complete manifest of file URIs, byte sizes and SHA-256 digests.
- `skills/get` retrieves one entry using its `SKILL.md` URI.
- `resources/read` retrieves the exact file content. For example, `skill://capgo/ship-live-update/SKILL.md`.
- `resources/directory/read` is not implemented or advertised; clients can navigate the complete manifest instead.

The public catalog and resource responses carry `ttlMs: 3600000` and `cacheScope: "public"`. These are client cache hints; authenticated POST requests are still required. Unknown URIs and cursors are rejected. No filesystem path or remote URL supplied by a caller is opened.

Modern clients send a single JSON-RPC message per POST, with matching `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method` headers. `tools/call`, `resources/read` and `prompts/get` also require `Mcp-Name`, matching the name or URI. Each request's `params._meta` must contain `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (which may be `{}`). `io.modelcontextprotocol/clientInfo` is optional. Modern results include `resultType: "complete"` and server identity metadata. Malformed requests return HTTP 400 and unknown methods return HTTP 404.

Existing clients keep the `initialize` flow and their original response shapes. That handshake negotiates only legacy versions, up to `2025-11-25`; modern clients use `server/discover` or send requests directly with per-request metadata.

### Maintaining the catalog

`scripts/generate-mcp-skills.ts` explicitly lists the published directories under `skills/` and `cli/skills/`. It includes all files in each selected directory, refuses symlinks, preserves UTF-8 content and frontmatter, and hashes the original bytes. It never scans a user's installed skills or the CLI's `_artifacts` folder. Review every file in a directory before adding it to the public catalog.

After editing a published skill, run `bun run generate:mcp-skills` and commit `cli/src/mcp/skills.generated.json`. Run `bun run check:mcp-skills` to check for drift. The unit suite also compares the generated artifact against the source files. The CLI MCP bundles this same catalog at release time and exposes the same skills methods, resources and compatibility tools. Runtime reads use only the bundled catalog, with no network or database access. CLI users receive catalog updates in a new CLI release.

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

## MCP Events

The hosted server implements the MCP Events extension (`events/list`, `events/subscribe`, `events/unsubscribe`). Subscriptions create rows in `public.webhooks` with `source = mcp`, reuse the existing webhook delivery queue, and sign deliveries as Standard Webhooks with `webhook-id`, `webhook-timestamp`, `webhook-signature`, and `X-MCP-Subscription-Id`.

Event catalog:

| Event | When it fires |
| --- | --- |
| `build.succeeded` | Native build reaches succeeded |
| `build.failed` | Native build fails or times out (`failure_category` includes `timeout`) |
| `bundle.uploaded` | New bundle version inserted (`app_versions` INSERT) |
| `bundle.deployed` | Channel `version` changes on `channels` UPDATE |

Default subscription TTL is 24 hours. Refresh by calling `events/subscribe` again before `refreshBefore`. Each organization may hold up to 25 active MCP subscriptions.

Tool wrappers for clients without protocol support: `capgo_list_event_types`, `capgo_subscribe_events`, `capgo_list_event_subscriptions`, `capgo_unsubscribe_events`.

## Tools

The hosted server has 77 tools. They cover:
- account and organizations, including members, audit logs and API keys,
- apps,
- bundles,
- channels and progressive rollouts,
- devices and channel overrides,
- statistics and Observe,
- build status, logs and cancel,
- webhooks,
- push notifications,
- documentation search and skill discovery.

API tools use typed zod schemas over existing public API routes. The route is replayed inside the API worker with the caller's API key, so RBAC, rate limits and audit logs behave exactly like the REST API. Skill tools read the bundled public catalog without calling those routes.

Tool annotations tell clients how careful to be:
- `readOnlyHint` marks tools that only read data.
- `destructiveHint` marks tools that delete, cancel or overwrite data (channel deploys, rollouts, settings updates). Clients should ask the user for confirmation before calling them.

Code: `supabase/functions/_backend/mcp/` (transport, protocol, tools and OAuth) and `supabase/functions/_backend/private/mcp_oauth.ts` (consent API). The console page is `src/pages/oauth/authorize.vue`.

## ChatGPT / Codex plugin

The OpenAI plugin package for this server lives at the repo root (`plugin.json`, `mcp.json`, `skills/`, `assets/plugin/`); its notes are in `integrations/openai-plugin/`. Build the submission ZIP with `bun scripts/build-openai-plugin.ts`. OpenAI domain verification is served from `/.well-known/openai-apps-challenge` using the `OPENAI_APPS_CHALLENGE_TOKEN` worker secret.
