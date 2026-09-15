#!/usr/bin/env node
/**
 * Capacitor 9 deprecated native API guard.
 *
 * Fails when plugin native sources still use APIs removed in Capacitor 9.
 * Does not flag Cordova SwiftPM product dependencies (still required on Cap 8).
 *
 * Usage:
 *   node scripts/check-cap9-deprecated.mjs packages/capacitor-notifications
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PLUGIN_REL_PATTERN = /^packages\/[\w-]+(?:\/[\w-]+)*$/

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.build',
  '.gradle',
  'Pods',
  'DerivedData',
  '.swiftpm',
  '.git',
  'example-app',
])

/** @type {{ id: string, pattern: RegExp, exts: string[], ignoreLine?: RegExp }[]} */
const RULES = [
  {
    id: 'hasOption',
    pattern: /\bhasOption\s*\(/,
    exts: ['.java', '.kt', '.swift'],
  },
  {
    id: 'getConfigValue',
    pattern: /\bgetConfigValue\s*\(/,
    exts: ['.java', '.kt', '.swift'],
  },
  {
    id: '@NativePlugin',
    pattern: /@NativePlugin\b/,
    exts: ['.java', '.kt'],
  },
  {
    id: 'saveCall',
    pattern: /\bsaveCall\s*\(/,
    exts: ['.java', '.kt', '.swift'],
  },
  {
    id: 'getSavedCall',
    pattern: /\bgetSavedCall\s*\(/,
    exts: ['.java', '.kt', '.swift'],
  },
  {
    id: 'freeSavedCall',
    pattern: /\bfreeSavedCall\s*\(/,
    exts: ['.java', '.kt', '.swift'],
  },
  {
    id: 'releaseCall',
    pattern: /\breleaseCall\s*\(/,
    exts: ['.java', '.kt', '.swift'],
  },
  {
    id: 'pluginRequestPermission',
    pattern: /\bpluginRequestPermissions?\s*\(/,
    exts: ['.java', '.kt'],
  },
  {
    id: 'pluginRequestAllPermissions',
    pattern: /\bpluginRequestAllPermissions\s*\(/,
    exts: ['.java', '.kt'],
  },
  {
    id: 'hasDefinedPermissions',
    pattern: /\bhasDefinedPermissions\s*\(/,
    exts: ['.java', '.kt'],
  },
  {
    id: 'CAPBridge',
    pattern: /\bCAPBridge\./,
    exts: ['.swift'],
    ignoreLine: /CAPBridgedPlugin/,
  },
  {
    id: 'CAPNotifications',
    pattern: /\bCAPNotifications\b/,
    exts: ['.swift'],
  },
]

const CORDova_SPM_LINE
  = /\.product\s*\(\s*name\s*:\s*"Cordova"\s*,\s*package\s*:\s*"capacitor-swift-pm"\s*\)/

/** @type {string} */
let pluginRoot = ''

/** Returns whether `targetPath` resolves inside `rootDir`. */
function isUnderRoot(targetPath, rootDir) {
  const resolved = path.resolve(targetPath)
  const rel = path.relative(rootDir, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolve plugin directory from a repo-relative path (no cwd / free-form CLI paths).
 * @param {string | undefined} pluginRel
 * @returns {string | null}
 */
function resolvePluginDir(pluginRel) {
  if (!pluginRel) {
    console.error('[cap9-deprecated] ERROR: missing plugin path (expected packages/<name>)')
    return null
  }
  const normalized = pluginRel.replaceAll('\\', '/')
  if (!PLUGIN_REL_PATTERN.test(normalized)) {
    console.error('[cap9-deprecated] ERROR: plugin path must match packages/<name>')
    return null
  }
  const abs = path.join(REPO_ROOT, normalized)
  if (!isUnderRoot(abs, REPO_ROOT)) {
    console.error('[cap9-deprecated] ERROR: plugin dir must stay inside repo')
    return null
  }
  return abs
}

/** @param {string} p */
function readText(p) {
  const resolved = path.resolve(p)
  if (!isUnderRoot(resolved, pluginRoot) || !fs.existsSync(resolved)) {
    return ''
  }
  return fs.readFileSync(resolved, 'utf8')
}

/** @param {string} p */
function exists(p) {
  const resolved = path.resolve(p)
  return isUnderRoot(resolved, pluginRoot) && fs.existsSync(resolved)
}

/** @param {string} rootDir @param {string[]} exts */
function walkFiles(rootDir, exts) {
  const out = []
  const stack = [rootDir]
  while (stack.length) {
    const dir = stack.pop()
    if (!dir || !isUnderRoot(dir, pluginRoot)) {
      continue
    }
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[cap9-deprecated] skip unreadable directory ${dir}: ${message}`)
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name))
          continue
        stack.push(path.join(dir, e.name))
        continue
      }
      if (!e.isFile())
        continue
      for (const ext of exts) {
        if (e.name.endsWith(ext)) {
          out.push(path.join(dir, e.name))
          break
        }
      }
    }
  }
  out.sort()
  return out
}

/** @param {string} pluginDir @param {Record<string, unknown>} pkg */
function collectScanRoots(pluginDir, pkg) {
  const cap = typeof pkg.capacitor === 'object' && pkg.capacitor ? pkg.capacitor : {}
  const roots = []
  if (cap.android) {
    const androidMain = path.join(pluginDir, 'android', 'src', 'main')
    if (exists(androidMain))
      roots.push(androidMain)
  }
  if (cap.ios) {
    const iosSources = path.join(pluginDir, 'ios', 'Sources')
    if (exists(iosSources))
      roots.push(iosSources)
    else {
      const iosDir = path.join(pluginDir, 'ios')
      if (exists(iosDir))
        roots.push(iosDir)
    }
  }
  const packageSwift = path.join(pluginDir, 'Package.swift')
  if (exists(packageSwift))
    roots.push(packageSwift)
  return roots
}

/** @param {string} filePath @param {{ exts: string[], ignoreLine?: RegExp, pattern: RegExp }} rule */
function scanFile(filePath, rule) {
  const ext = path.extname(filePath)
  if (!rule.exts.includes(ext))
    return []

  const txt = readText(filePath)
  const lines = txt.split(/\r?\n/)
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (filePath.endsWith('Package.swift') && CORDova_SPM_LINE.test(line)) {
      continue
    }
    if (rule.ignoreLine?.test(line))
      continue
    if (rule.pattern.test(line)) {
      hits.push({ line: i + 1, text: line.trim() })
    }
  }
  return hits
}

function run() {
  pluginRoot = resolvePluginDir(process.argv[2]) ?? ''
  if (!pluginRoot) {
    console.error('Usage: node scripts/check-cap9-deprecated.mjs packages/<plugin-name>')
    process.exitCode = 2
    return
  }

  const pkgPath = path.join(pluginRoot, 'package.json')
  if (!exists(pkgPath)) {
    console.error(`[cap9-deprecated] ERROR: missing package.json in ${pluginRoot}`)
    process.exitCode = 2
    return
  }

  let pkg
  try {
    pkg = JSON.parse(readText(pkgPath))
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[cap9-deprecated] ERROR: invalid package.json (${pkgPath}): ${message}`)
    process.exitCode = 2
    return
  }

  const cap = typeof pkg.capacitor === 'object' && pkg.capacitor ? pkg.capacitor : {}
  if (!cap.android && !cap.ios) {
    process.exitCode = 0
    return
  }

  const scanRoots = collectScanRoots(pluginRoot, pkg)
  const allExts = [...new Set(RULES.flatMap(r => r.exts))]
  const files = []
  for (const root of scanRoots) {
    if (root.endsWith('Package.swift')) {
      files.push(root)
      continue
    }
    files.push(...walkFiles(root, allExts))
  }

  const violations = []
  for (const file of files) {
    for (const rule of RULES) {
      const hits = scanFile(file, rule)
      for (const hit of hits) {
        violations.push({
          rule: rule.id,
          file: path.relative(pluginRoot, file),
          line: hit.line,
          text: hit.text,
        })
      }
    }
  }

  if (violations.length) {
    const relDir = path.relative(REPO_ROOT, pluginRoot) || '.'
    console.error(`[cap9-deprecated] FAIL in ${relDir}`)
    for (const v of violations) {
      console.error(`  - ${v.rule}: ${v.file}:${v.line}: ${v.text}`)
    }
    process.exitCode = 1
    return
  }

  process.exitCode = 0
}

run()
