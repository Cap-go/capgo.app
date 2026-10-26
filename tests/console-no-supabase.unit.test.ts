// Guard: the console only talks to Capgo through the Capgo API. No Supabase SDK,
// hosts, keys or REST/Auth/Storage URL layouts, so the backend can move off
// Supabase without a console change. Generated database types stay shared.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

const forbidden: Array<{ pattern: RegExp, reason: string }> = [
  { pattern: /\b(?:from|import)\s*\(?['"]@supabase\//, reason: 'Supabase SDK import' },
  { pattern: /@capgo\/capacitor-supabase/, reason: 'Capacitor Supabase plugin' },
  { pattern: /VITE_SUPABASE_|\bSUPA_(?:URL|ANON)\b/, reason: 'Supabase build env' },
  { pattern: /\bsupa(?:Host|Key|ProxyPath)\b|\bsupbaseId\b/, reason: 'Supabase config field' },
  { pattern: /\/(?:rest|storage|auth)\/v1\b/, reason: 'direct Supabase REST/Auth/Storage URL' },
  { pattern: /\bsb\.capgo\.app\b|\.supabase\.co\b/, reason: 'Supabase host' },
  { pattern: /configs\.json/, reason: 'configs.json carries backend keys and must not be bundled' },
]

// The confirmation-link resolver names the legacy verify path so it can rewrite it onto the API.
const allowed = new Set(['src/utils/safeRedirect.ts: direct Supabase REST/Auth/Storage URL'])

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      walk(path, out)
      continue
    }
    if (/\.(?:ts|mts|vue|js|mjs)$/.test(entry))
      out.push(path)
  }
  return out
}

describe('console never talks to Supabase', () => {
  it('keeps src/ free of Supabase SDK, hosts, keys and env', () => {
    const offenders: string[] = []
    for (const file of walk(join(root, 'src'), [])) {
      const source = readFileSync(file, 'utf8')
      for (const { pattern, reason } of forbidden) {
        const offender = `${relative(root, file)}: ${reason}`
        if (pattern.test(source) && !allowed.has(offender))
          offenders.push(offender)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the console source free of the word Supabase', () => {
    const offenders: string[] = []
    // The generated database types carry the generator's own marker.
    for (const file of walk(join(root, 'src'), []).filter(file => !file.endsWith('database.types.ts'))) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        // Shared backend modules live under supabase/functions; importing them is a repo path, not a dependency.
        if (/supabase/i.test(line) && !/supabase\/functions\//.test(line))
          offenders.push(`${relative(root, file)}:${index + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps package.json free of the Capacitor Supabase plugin', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
      expect(Object.keys(pkg[field] ?? {})).not.toContain('@capgo/capacitor-supabase')
  })

  // Same prism as CLI GET /bundle?fields=summary: list/picker paths must not pull
  // the large manifest / native_packages columns via select('*') or bare select().
  it('keeps app_versions list queries on light columns', () => {
    const heavy = /\.from\(\s*['"]app_versions['"]\s*\)[\s\S]{0,120}?\.select\(\s*(?:\(\s*\)|['"]\*['"])/
    const offenders: string[] = []
    for (const file of walk(join(root, 'src'), []).filter(path => /\.(?:ts|vue)$/.test(path))) {
      const source = readFileSync(file, 'utf8')
      if (heavy.test(source))
        offenders.push(relative(root, file))
    }
    expect(offenders).toEqual([])
  })
})
