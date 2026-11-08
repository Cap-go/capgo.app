#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const REF = process.argv[2] || 'origin/main'
const PR = 'supabase/functions/_backend/plugin_runtime/utils'
const MAIN = 'supabase/functions/_backend/utils'

function readAt(ref, rel) {
  try {
    return execSync(`git show ${ref}:${rel}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  }
  catch {
    return null
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const prFiles = execSync(`git ls-tree --name-only ${REF}:${PR}`, { cwd: ROOT, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(f => f.endsWith('.ts'))

const identical = []
const diverged = []
const onlyPr = []

for (const f of prFiles.sort()) {
  const prRel = `${PR}/${f}`
  const mainRel = `${MAIN}/${f}`
  const a = readAt(REF, prRel)
  const b = readAt(REF, mainRel)
  if (b === null) {
    onlyPr.push(f)
    continue
  }
  const ha = sha256(a)
  const hb = sha256(b)
  if (a === b)
    identical.push({ f, hash: ha })
  else
    diverged.push({ f, hashPr: ha, hashMain: hb, bytesPr: Buffer.byteLength(a), bytesMain: Buffer.byteLength(b) })
}

console.log(JSON.stringify({ ref: REF, identical, diverged, onlyPr }, null, 2))
