import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { html } from 'hono/html'
import { Hono } from 'hono/tiny'
import { MCP_SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from './metadata.ts'
import { getApiOrigin, getResourceUrl, MCP_PATH } from './oauth_shared.ts'
import { sha256Hex } from './oauth_utils.ts'

const CARD_TYPE = 'application/mcp-server-card+json'
const DOCS_URL = 'https://capgo.app/docs/ai/mcp/'

function remote(c: Context) {
  return {
    type: 'streamable-http',
    url: getResourceUrl(c),
    supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  }
}

function serverCard(c: Context) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    ...MCP_SERVER_INFO,
    remotes: [remote(c)],
  }
}

async function publicJson(c: Context, data: unknown, contentType: string) {
  const tag = `"${await sha256Hex(JSON.stringify(data))}"`
  c.header('Cache-Control', 'public, max-age=3600')
  c.header('ETag', tag)
  const matches = c.req.header('If-None-Match')?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === tag)
  if (matches)
    return c.body(null, 304)
  return c.json(data, 200, { 'Content-Type': `${contentType}; charset=utf-8` })
}

export function createMcpDiscoveryApp() {
  const app = new Hono<MiddlewareKeyVariables>()
  // Keep the legacy URL for scanners that have not adopted SEP-2127's recommended location.
  for (const path of [`${MCP_PATH}/server-card`, '/.well-known/mcp/server-card.json'])
    app.get(path, c => publicJson(c, serverCard(c), CARD_TYPE))

  // mcp.json is a Registry manifest, not a Server Card: the documents use separate schemas.
  for (const path of ['/.well-known/mcp.json', '/mcp.json']) {
    app.get(path, c => publicJson(c, {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      ...MCP_SERVER_INFO,
      remotes: [{ type: 'streamable-http', url: getResourceUrl(c) }],
    }, 'application/json'))
  }

  app.get('/.well-known/ai-catalog.json', c => publicJson(c, {
    specVersion: '1.0',
    entries: [{
      identifier: 'urn:air:capgo.app:mcp:capgo',
      type: CARD_TYPE,
      url: `${getResourceUrl(c)}/server-card`,
    }],
  }, 'application/ai-catalog+json'))
  return app
}

export function mcpSetupPage(c: Context) {
  const endpoint = getResourceUrl(c)
  const config = JSON.stringify({ mcpServers: { capgo: { url: endpoint } } }, null, 2)
  c.header('Cache-Control', 'no-store')
  return c.html(html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Connect your AI assistant to Capgo to build and release Capacitor apps.">
  <title>Connect to Capgo MCP</title>
  <link rel="icon" href="https://capgo.app/favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="application/mcp-server-card+json" href="${endpoint}/server-card">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.6; }
    body { max-width: 48rem; margin: 4rem auto; padding: 0 1.5rem; }
    h1, h2 { line-height: 1.2; }
    code { overflow-wrap: anywhere; }
    pre { white-space: pre-wrap; }
    li { margin-block: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <h1>Connect to Capgo MCP</h1>
    <p>Manage Capacitor apps, live updates, channels, native builds and app health from your AI assistant.</p>
    <h2>Connect with OAuth</h2>
    <ol>
      <li>Add a remote MCP server in your assistant or editor.</li>
      <li>Enter <code>${endpoint}</code> and select Streamable HTTP if asked for a transport.</li>
      <li>Sign in to Capgo and approve access to the organizations you want to share.</li>
    </ol>
    <p>For clients that accept an MCP configuration file:</p>
    <pre><code>${config}</code></pre>
    <h2>Connect with an API key</h2>
    <p>If your client uses header authentication, create a key in
      <a href="https://console.capgo.app/apikeys">Capgo API keys</a> and configure
      <code>Authorization: Bearer &lt;Capgo API key&gt;</code> in the client's secret settings. Keep the key out of chat and shared configuration files.</p>
    <p>Ask your agent to run <code>capgo_whoami</code> to confirm its connection, then <code>capgo_list_apps</code> to find your apps. Access is limited by the connected API key's permissions. Confirm deployments, destructive actions and push notifications before running them.</p>
    <h2>Local CLI</h2>
    <p>To use the local MCP server, run <code>npx @capgo/cli@latest login</code>,
      then configure your client to launch <code>npx @capgo/cli@latest mcp</code>.</p>
    <p><a href="${DOCS_URL}">Full setup documentation</a> ·
      <a href="${endpoint}/server-card">MCP Server Card</a> ·
      <a href="${getApiOrigin(c)}/.well-known/mcp.json">Registry manifest</a></p>
  </main>
</body>
</html>`)
}
