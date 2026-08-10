import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const en = JSON.parse(readFileSync(join(root, 'messages/en.json'), 'utf8'))
const keys = Object.keys(en).filter(key => key !== '$schema')
const keySet = new Set(keys)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'graphify-out')
      continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) {
      walk(path, out)
      continue
    }
    if (/\.(vue|ts|js|tsx|jsx|mjs|cjs)$/.test(name))
      out.push(path)
  }
  return out
}

const files = walk(join(root, 'src'))
const usage = new Map()

function addUsage(key, rel) {
  if (!keySet.has(key))
    return
  if (!usage.has(key))
    usage.set(key, new Set())
  usage.get(key).add(rel)
}

const directPatterns = [
  /(?:\$?t|i18n\.global\.t)\(\s*['"`]([\w.-]+)['"`]/g,
  /(?:label|title|placeholder|description|heading|message|text|tooltip|hint|i18nKey|translationKey|name)\s*:\s*['"`]([\w.-]+)['"`]/g,
  /(?:label|title|placeholder|description|heading|aria-label|ariaLabel)\s*=\s*['"`]([\w.-]+)['"`]/g,
]

for (const file of files) {
  const content = readFileSync(file, 'utf8')
  const rel = relative(root, file)

  for (const pattern of directPatterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null)
      addUsage(match[1], rel)
  }

  // Catch known keys appearing as quoted literals in source (nav labels, maps, enums).
  const literalPattern = /['"`]([\w.-]+)['"`]/g
  let match
  while ((match = literalPattern.exec(content)) !== null) {
    const key = match[1]
    if (!keySet.has(key))
      continue
    // Skip very short generic tokens unless they are known UI keys used as labels.
    if (key.length < 3 && key !== 'ok')
      continue
    addUsage(key, rel)
  }
}

function humanizePath(path) {
  return path
    .replace(/^src\//, '')
    .replace(/^pages\//, 'page ')
    .replace(/^components\//, 'component ')
    .replace(/^services\//, 'service ')
    .replace(/^stores\//, 'store ')
    .replace(/^layouts\//, 'layout ')
    .replace(/^constants\//, 'constants ')
    .replace(/\.vue$/, '')
    .replace(/\.ts$/, '')
    .replace(/\./g, ' ')
    .replace(/\//g, ' › ')
    .replace(/\[([^\]]+)\]/g, '($1)')
}

function inferUiRole(text, key) {
  const k = key.toLowerCase()
  if (k.endsWith('-placeholder') || k.includes('placeholder'))
    return 'input placeholder'
  if (k.endsWith('-title') || k.endsWith('-heading'))
    return 'section or dialog title'
  if (k.endsWith('-description') || k.endsWith('-desc') || k.endsWith('-help'))
    return 'helper or description text'
  if (k.endsWith('-tooltip'))
    return 'tooltip'
  if (k.startsWith('action-'))
    return 'device or update event label in logs/analytics'
  if (k.includes('toast') || /\b(success|error|failed|warning)\b/.test(k))
    return 'toast or status message'
  if (
    k.includes('button')
    || k.startsWith('btn-')
    || /^(save|cancel|delete|confirm|create|update|edit|add|remove|enable|disable|continue|back|next|submit|close|done|retry|download|upload|copy|invite|accept|reject)$/i.test(k)
  ) {
    return 'button or action label'
  }
  if (/\d+-days$/.test(k) || k === 'filters' || k === 'current')
    return 'filter or date-range option label'
  if (k.includes('empty') || k.startsWith('no-'))
    return 'empty state text'
  if (text.trim().length <= 24 && !text.trim().includes(' '))
    return 'short UI label'
  if (text.trim().length <= 40)
    return 'UI label'
  return 'UI sentence'
}

function topicFromKey(key) {
  return key.replace(/-/g, ' ')
}

function namespaceHint(key) {
  const prefixes = [
    ['2fa-', 'organization/account two-factor authentication'],
    ['admin-', 'platform admin dashboard'],
    ['api-key', 'API key management'],
    ['app-onboarding', 'app onboarding flow'],
    ['app-', 'application settings or app detail'],
    ['bundle-', 'bundle management'],
    ['channel-', 'channel settings'],
    ['device-', 'device management'],
    ['org-', 'organization settings'],
    ['plan-', 'billing/plans'],
    ['stripe-', 'billing/Stripe'],
    ['webhook-', 'webhook settings'],
    ['action-', 'plugin update/action event names'],
    ['build-', 'native build system'],
    ['credit', 'usage credits billing'],
    ['replication-', 'update replication toast/status'],
  ]
  for (const [prefix, hint] of prefixes) {
    if (key.startsWith(prefix) || key.includes(prefix))
      return hint
  }
  return 'Capgo web console'
}

function keyFallbackContext(key, text) {
  const role = inferUiRole(text, key)
  const area = namespaceHint(key)
  return `Used in ${area}. Role: ${role} about "${topicFromKey(key)}". Translate for UI; keep Capgo product names, code, and placeholders unchanged.`
}

const contexts = {}
let withUsage = 0
for (const key of keys) {
  const text = en[key]
  const filesForKey = usage.get(key)
  if (filesForKey && filesForKey.size > 0) {
    withUsage += 1
    const locs = [...filesForKey].slice(0, 5).map(humanizePath).join('; ')
    const role = inferUiRole(text, key)
    contexts[key] = `Used in Capgo web console: ${locs}. Role: ${role}. Translate for UI; keep Capgo product names, code, and placeholders unchanged.`
  }
  else {
    contexts[key] = keyFallbackContext(key, text)
  }
}

const outPath = join(root, 'messages/en.context.json')
writeFileSync(outPath, `${JSON.stringify(contexts, null, 2)}\n`)

console.log(JSON.stringify({
  keys: keys.length,
  withUsage,
  withoutUsage: keys.length - withUsage,
  outPath: relative(root, outPath),
  samples: {
    account: contexts.account,
    Current: contexts.Current,
    Filters: contexts.Filters,
    MAU: contexts.MAU,
    'action-app-crash': contexts['action-app-crash'],
    '2fa': contexts['2fa'],
  },
}, null, 2))
