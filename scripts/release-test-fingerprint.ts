/**
 * Print a fingerprint of the tested source at a commit, ignoring files that only the
 * release bot rewrites (version strings, generated CLI docs).
 *
 * A pull_request test run records this fingerprint for its merge commit. The bump
 * workflow on main computes it for the pushed commit, and when they match, the code
 * that passed in the PR is exactly the code being released, so the release gate can
 * reuse that result instead of running the same suites again.
 *
 * Usage: node scripts/release-test-fingerprint.ts [rev]  (or bun)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import process from 'node:process'

const IGNORED_PREFIXES = [
  'cli/webdocs/',
]

const IGNORED_FILES = new Set([
  'cli/README.md',
  'supabase/functions/_backend/utils/version.ts',
  'supabase/functions/_backend/plugin_runtime/utils/version.ts',
  'packages/capacitor-notifications/src/version.ts',
])

// The release bot only changes the top-level "version" field in these manifests.
const VERSIONED_MANIFESTS = new Set([
  'package.json',
  'cli/package.json',
  'packages/capacitor-notifications/package.json',
])

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function manifestWithoutVersion(rev: string, path: string): string {
  const manifest = JSON.parse(git(['show', `${rev}:${path}`])) as Record<string, unknown>
  delete manifest.version
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

function releaseTestFingerprint(rev: string): string {
  const hash = createHash('sha256')
  for (const entry of git(['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0')) {
    if (!entry)
      continue
    const tab = entry.indexOf('\t')
    const [mode, , object] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    if (IGNORED_FILES.has(path) || IGNORED_PREFIXES.some(prefix => path.startsWith(prefix)))
      continue
    const content = VERSIONED_MANIFESTS.has(path) ? manifestWithoutVersion(rev, path) : object
    hash.update(`${mode} ${path} ${content}\n`)
  }
  return hash.digest('hex')
}

console.log(releaseTestFingerprint(process.argv[2] ?? 'HEAD'))
