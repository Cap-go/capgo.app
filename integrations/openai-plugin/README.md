# Capgo plugin for ChatGPT and Codex

OpenAI plugin package for the hosted Capgo MCP server (`https://api.capgo.app/mcp`, see `docs/hosted-mcp.md`).
Submission guide: https://developers.openai.com/plugins/deploy/submission

```
plugin.json          manifest + listing metadata (extensions.com.openai.interface)
mcp.json             hosted MCP server (streamable-http)
skills/              workflow skills bundled with the plugin
assets/              logo and composer icon
```

The ZIP must not contain this README or `REVIEW.md`; the build script only packages the files above.

## Build the ZIP

```bash
bun scripts/build-openai-plugin.ts
```

It validates the manifest limits from the submission guide (field lengths, HTTPS URLs, relative `./` asset paths that exist, skill frontmatter) and writes `dist/openai-plugin/capgo-<version>.zip`.
Bump `version` in `plugin.json` for every new upload. Tool changes on the MCP server do not need a new package: OpenAI rescans the server daily (or on demand from the dashboard).

## Domain verification

When connecting the MCP server, the dashboard gives a challenge token. Serve it from the API worker:

```bash
bunx wrangler secret put OPENAI_APPS_CHALLENGE_TOKEN --config cloudflare_workers/api/wrangler.jsonc --env prod
curl https://api.capgo.app/.well-known/openai-apps-challenge      # must print only the token
```

The route returns 404 while the secret is unset.

## Submission checklist

1. Organization owner (or member with Apps Management Write) completes business verification.
2. Upload the ZIP, select the Capgo developer identity.
3. Connect the MCP server: complete domain verification, then the OAuth login with the reviewer account.
4. Fill review information from `REVIEW.md` (test cases, reviewer access, release notes, demo recording URL).
5. Attest policies and submit.
