// Routing rules remain in Cloudflare: they include private custom hostnames.
export const SNIPPET_ZONE_ID = '7fe39404d772c5a0b4444f5a0475a586'
export const MAX_SNIPPET_BYTES = 32 * 1024
export const SNIPPETS = [
  { name: 'plugin_load_balancer', source: 'cloudflare_workers/snippet/index.js' },
  { name: 'legacy_cli_manifest_warning', source: 'cloudflare_workers/legacy_cli_manifest_warning/index.js' },
  { name: 'inbox_message', source: 'cloudflare_workers/inbox_message/index.js' },
] as const

export interface BuiltSnippet {
  name: string
  code: string
}

export function validateSnippets(snippets: readonly BuiltSnippet[]): void {
  if (!snippets.length || new Set(snippets.map(snippet => snippet.name)).size !== snippets.length)
    throw new Error('Snippet catalog must be nonempty with unique names')
  for (const { name, code } of snippets) {
    if (!/^[a-z0-9_]+$/.test(name))
      throw new Error('Invalid snippet name')
    const bytes = new TextEncoder().encode(code).length
    if (!bytes || bytes > MAX_SNIPPET_BYTES)
      throw new Error(`Snippet ${name} must contain 1–${MAX_SNIPPET_BYTES} bytes (got ${bytes})`)
  }
}
