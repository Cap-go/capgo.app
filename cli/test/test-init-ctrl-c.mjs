import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const runtimePath = fileURLToPath(new URL('../src/init/runtime.tsx', import.meta.url))
const source = readFileSync(runtimePath, 'utf8')

assert.match(source, /render\(React\.createElement\(InitInkApp,[\s\S]*?exitOnCtrlC:\s*false/)
assert.doesNotMatch(source, /installInitInkOutputGuard/)
