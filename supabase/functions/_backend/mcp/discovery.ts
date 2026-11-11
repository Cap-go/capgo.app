import { SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.ts'

// The experimental Server Card extension uses a namespaced discovery name and a short description.
// Keep the established protocol name unchanged for existing clients.
export const MCP_SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'app.capgo/capgo',
  title: SERVER_INFO.title,
  version: SERVER_INFO.version,
  description: 'Manage Capacitor live updates, native builds, app health and organizations with Capgo.',
  websiteUrl: 'https://capgo.app/docs/ai/mcp/',
  icons: SERVER_INFO.icons,
  repository: {
    url: 'https://github.com/Cap-go/capgo.app',
    source: 'github',
    subfolder: 'supabase/functions/_backend/mcp',
  },
  remotes: [{
    type: 'streamable-http',
    url: 'https://api.capgo.app/mcp',
    supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  }],
}

export const MCP_AI_CATALOG = {
  specVersion: '1.0',
  entries: [{
    identifier: 'urn:air:capgo.app:mcp:capgo',
    type: 'application/mcp-server-card+json',
    url: 'https://api.capgo.app/mcp/server-card',
  }],
}

export const MCP_SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Connect your AI client to Capgo to manage Capacitor live updates, native builds and app health.">
  <title>Connect to Capgo MCP</title>
  <link rel="icon" href="https://capgo.app/favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="application/mcp-server-card+json" href="/mcp/server-card">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.6; }
    body { max-width: 48rem; margin: 4rem auto; padding: 0 1.5rem; }
    h1, h2 { line-height: 1.2; }
    code { overflow-wrap: anywhere; }
    li { margin-block: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <h1>Connect to Capgo MCP</h1>
    <p>Manage Capacitor live updates, native builds, app health and organizations from your AI client. Nothing needs to be installed for the hosted connection.</p>
    <h2>Set up your connection</h2>
    <ol>
      <li>Open your client's MCP server or connector settings and add a remote server named <strong>Capgo</strong>.</li>
      <li>Enter <code>https://api.capgo.app/mcp</code> as the server URL and choose <strong>Streamable HTTP</strong> if asked for a transport.</li>
      <li>Choose OAuth and sign in to Capgo, then select the organizations you want to share.</li>
    </ol>
    <p>If your client uses API key headers instead of OAuth, create a key in <a href="https://console.capgo.app/apikeys">Capgo API keys</a> and configure <code>Authorization: Bearer &lt;Capgo API key&gt;</code> in the client's secure connection settings. Keep the key out of chat and shared configuration files.</p>
    <h2>Start with your apps</h2>
    <p>Ask your agent to run <code>capgo_whoami</code> to confirm its connection, then <code>capgo_list_apps</code> to find your apps. Access is limited by the connected API key's permissions. Confirm deployments, destructive actions and push notifications before running them.</p>
    <p><a href="https://capgo.app/docs/ai/mcp/">Full setup documentation</a> · <a href="/mcp/server-card">Server card</a> · <a href="/.well-known/ai-catalog.json">AI catalog</a></p>
  </main>
</body>
</html>`
