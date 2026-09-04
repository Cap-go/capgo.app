#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildConsoleContentSecurityPolicy } from './console-security-policy.ts'

const headersPath = path.resolve(import.meta.dir, '../public/_headers')
const policy = buildConsoleContentSecurityPolicy()
const headers = readFileSync(headersPath, 'utf8')

const cspLine = `  Content-Security-Policy: ${policy}`
const nextHeaders = headers.replace(
  /^  Content-Security-Policy: .+$/m,
  cspLine,
)

if (nextHeaders === headers) {
  console.error('No Content-Security-Policy line found in public/_headers')
  process.exit(1)
}

writeFileSync(headersPath, nextHeaders)
console.log('Updated public/_headers Content-Security-Policy')
