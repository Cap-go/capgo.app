#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '../src')

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, files)
      continue
    }
    if (full.endsWith('.ts') || full.endsWith('.tsx'))
      files.push(full)
  }
  return files
}

const offenders = []
for (const file of walk(srcRoot)) {
  const rel = relative(srcRoot, file)
  if (rel === 'types/supabase.types.ts' || rel.startsWith('types/'))
    continue
  const source = readFileSync(file, 'utf8')
  if (source.includes('.rpc('))
    offenders.push(rel)
}

assert.equal(offenders.length, 0, `CLI src must not call supabase.rpc: ${offenders.join(', ')}`)
console.log('CLI src has no supabase.rpc calls')
