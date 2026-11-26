// Routing rules stay in Cloudflare unless a snippet declares `rule` here: then the
// deploy sets that rule's name (Cloudflare `description`) and expression. The
// plugin rule includes private custom hostnames and never goes in the repo.
export const SNIPPET_ZONE_ID = '7fe39404d772c5a0b4444f5a0475a586'
export const MAX_SNIPPET_BYTES = 32 * 1024
export const MAX_RULE_EXPRESSION_LENGTH = 4096

export interface SnippetRule {
  name: string
  expression: string
}

export const SNIPPETS: readonly { name: string, source: string, rule?: SnippetRule }[] = [
  { name: 'plugin_load_balancer', source: 'cloudflare_workers/snippet/index.js' },
  {
    name: 'legacy_cli_manifest_warning',
    source: 'cloudflare_workers/legacy_cli_manifest_warning/index.js',
    rule: {
      name: 'Legacy CLI on sb.capgo.app: manifest warning and old Edge Function calls',
      expression: [
        '(http.host eq "sb.capgo.app" and http.request.method eq "POST" and http.request.uri.path eq "/rest/v1/rpc/get_organization_cli_warnings")',
        'or (http.host eq "sb.capgo.app" and (http.request.uri.path eq "/functions/v1/bundle"',
        'or starts_with(http.request.uri.path, "/functions/v1/files/")',
        'or starts_with(http.request.uri.path, "/functions/v1/private/")))',
      ].join(' '),
    },
  },
  { name: 'inbox_message', source: 'cloudflare_workers/inbox_message/index.js' },
]

export interface BuiltSnippet {
  name: string
  code: string
  rule?: SnippetRule
}

export function validateSnippets(snippets: readonly BuiltSnippet[]): void {
  if (!snippets.length || new Set(snippets.map(snippet => snippet.name)).size !== snippets.length)
    throw new Error('Snippet catalog must be nonempty with unique names')
  for (const { name, code, rule } of snippets) {
    if (!/^[a-z0-9_]+$/.test(name))
      throw new Error('Invalid snippet name')
    const bytes = new TextEncoder().encode(code).length
    if (!bytes || bytes > MAX_SNIPPET_BYTES)
      throw new Error(`Snippet ${name} must contain 1–${MAX_SNIPPET_BYTES} bytes (got ${bytes})`)
    if (rule && name === 'plugin_load_balancer')
      throw new Error('plugin_load_balancer routing comes from custom domains, not from the catalog')
    if (rule && (!rule.name.trim() || !rule.expression.trim() || rule.expression.length > MAX_RULE_EXPRESSION_LENGTH))
      throw new Error(`Snippet ${name} rule needs a name and a 1–${MAX_RULE_EXPRESSION_LENGTH} character expression`)
  }
}
