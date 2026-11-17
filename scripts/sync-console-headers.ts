#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { withConsoleContentSecurityPolicy } from './console-security-policy.ts'

const headersPath = path.resolve(import.meta.dir, '../public/_headers')
const headers = readFileSync(headersPath, 'utf8')
const nextHeaders = withConsoleContentSecurityPolicy(headers)

if (nextHeaders === headers) {
  console.log('Content-Security-Policy already up to date in public/_headers')
  process.exit(0)
}

writeFileSync(headersPath, nextHeaders)
console.log('Updated public/_headers Content-Security-Policy')
