#!/usr/bin/env bun
/**
 * Fail when any wrangler config sets compatibility_date after today (UTC).
 * Cloudflare API error 10021 rejects future dates at deploy time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './generate-plugin-route-hosts.ts'

const WRANGLER_BASENAMES = new Set(['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'])
const TOML_COMPAT_RE = /^\s*compatibility_date\s*=\s*"([^"]+)"/gm

export interface CompatViolation {
  file: string
  date: string
}

export function todayUtcIsoDate(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function isCompatibilityDateAfter(date: string, maxInclusive: string): boolean {
  return date > maxInclusive
}

export function collectCompatibilityDatesFromJson(value: unknown, keyPath = ''): Array<{ path: string, date: string }> {
  const out: Array<{ path: string, date: string }> = []
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = keyPath ? `${keyPath}.${key}` : key
      if (key === 'compatibility_date' && typeof child === 'string')
        out.push({ path, date: child })
      else
        out.push(...collectCompatibilityDatesFromJson(child, path))
    }
  }
  return out
}

export function compatibilityDatesFromToml(text: string): string[] {
  return [...text.matchAll(TOML_COMPAT_RE)].map(match => match[1])
}

export function compatibilityDatesFromWranglerFile(filePath: string, content: string): string[] {
  const base = basename(filePath)
  if (base === 'wrangler.toml')
    return compatibilityDatesFromToml(content)
  const parsed = base.endsWith('.jsonc') ? parseJsonc(content) : JSON.parse(content)
  return collectCompatibilityDatesFromJson(parsed).map(entry => entry.date)
}

export function findWranglerConfigFiles(rootDir: string): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git')
        continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (WRANGLER_BASENAMES.has(name))
        files.push(full)
    }
  }
  walk(rootDir)
  return files.sort()
}

export function checkWranglerCompatibilityDates(rootDir: string, maxInclusive: string): CompatViolation[] {
  const violations: CompatViolation[] = []
  for (const file of findWranglerConfigFiles(rootDir)) {
    const content = readFileSync(file, 'utf8')
    for (const date of compatibilityDatesFromWranglerFile(file, content)) {
      if (isCompatibilityDateAfter(date, maxInclusive))
        violations.push({ file, date })
    }
  }
  return violations
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  const max = process.env.WRANGLER_COMPAT_CHECK_MAX_DATE ?? todayUtcIsoDate()
  const violations = checkWranglerCompatibilityDates(root, max)
  if (violations.length) {
    for (const violation of violations)
      console.error(`${violation.file}: compatibility_date ${violation.date} is after ${max} (UTC)`)
    process.exit(1)
  }
  console.log(`wrangler compatibility_date OK (max ${max} UTC, ${findWranglerConfigFiles(root).length} file(s))`)
}
