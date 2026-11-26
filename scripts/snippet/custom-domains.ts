import { MAX_RULE_EXPRESSION_LENGTH } from './catalog.ts'

// Zone invariant: all SaaS custom hostnames, including manually configured ones,
// serve the Live Updates API. Native hosts keep their existing routing branches.
// Exact paths mirror the public plugin routes, including the legacy aliases and
// manifest-size endpoint. Host normalization excludes case and DNS-root-dot
// variants of internal targets too. Methods remain the Worker's responsibility,
// including CORS preflight and channel GET/PUT/DELETE; do not restrict to POST.
export const CUSTOM_DOMAIN_PLUGIN_EXPRESSION = [
  '(not (lower(trim_end(http.host, ".")) eq "capgo.app"',
  'or ends_with(lower(trim_end(http.host, ".")), ".capgo.app")',
  'or lower(trim_end(http.host, ".")) eq "workers.dev"',
  'or ends_with(lower(trim_end(http.host, ".")), ".workers.dev"))',
  'and http.request.uri.path in {"/updates" "/stats" "/channel_self" "/updates/manifest_size"',
  '"/plugin/updates" "/plugin/stats" "/plugin/channel_self" "/plugin/updates/manifest_size"})',
].join(' ')

// Split only unconditional OR alternatives. A branch inside AND, NOT, or a
// quoted string must not count as coverage. Preserve the original live text.
function unconditionalAlternatives(expression: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let firstGroupEnd = -1
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '"' || (expression[i] === 'r' && /^r#*"/.test(expression.slice(i)))) {
      const raw = /^r(#*)"/.exec(expression.slice(i))
      const close = raw ? `"${raw[1]}` : '"'
      i += raw ? raw[0].length : 1
      while (i < expression.length && !expression.startsWith(close, i)) {
        if (!raw && expression[i] === '\\') i++
        i++
      }
      if (i >= expression.length)
        throw new Error('Cannot safely parse the live plugin snippet expression')
      i += close.length - 1
      continue
    }
    if (expression[i] === '(') depth++
    if (expression[i] === ')') {
      depth--
      if (depth === 0 && firstGroupEnd === -1) firstGroupEnd = i
    }
    if (depth < 0)
      throw new Error('Cannot safely parse the live plugin snippet expression')
    const separatorLength = depth !== 0 ? 0 : expression.startsWith('||', i)
      ? 2
      : expression.startsWith('or', i)
        && !/[\w.]/.test(expression[i - 1] ?? '') && !/[\w.]/.test(expression[i + 2] ?? '')
        ? 2
        : 0
    if (separatorLength) {
      parts.push(expression.slice(start, i).trim())
      i += separatorLength - 1
      start = i + 1
    }
  }
  if (depth !== 0)
    throw new Error('Cannot safely parse the live plugin snippet expression')
  if (parts.length)
    return [...parts, expression.slice(start).trim()].flatMap(unconditionalAlternatives)
  if (expression.startsWith('(') && firstGroupEnd === expression.length - 1)
    return unconditionalAlternatives(expression.slice(1, -1).trim())
  return [expression]
}

function comparisonTokens(expression: string): string {
  // Preserve entire quoted literals and token boundaries; only spacing outside
  // strings is insignificant. Raw strings may contain quotes and whitespace.
  return JSON.stringify(expression.match(/r(#*)"[\s\S]*?"\1|"(?:[^"\\]|\\.)*"|[a-z_][a-z0-9_.]*|[^\s]/gi))
}

export function includeCustomDomainRouting(expression: string): { expression: string, changed: boolean } {
  if (!expression.trim())
    throw new Error('Cannot safely parse the live plugin snippet expression')
  const existing = unconditionalAlternatives(expression.trim())
  const branch = CUSTOM_DOMAIN_PLUGIN_EXPRESSION.slice(1, -1)
  const tokens = comparisonTokens(branch)
  const changed = !existing.some(alternative => comparisonTokens(alternative) === tokens)
  const updated = changed ? `(${expression}) or ${CUSTOM_DOMAIN_PLUGIN_EXPRESSION}` : expression
  if (updated.length > MAX_RULE_EXPRESSION_LENGTH)
    throw new Error(`Custom-domain routing would exceed the ${MAX_RULE_EXPRESSION_LENGTH}-character expression limit (current=${expression.length}, planned=${updated.length})`)
  return { expression: updated, changed }
}
