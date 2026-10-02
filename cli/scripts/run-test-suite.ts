#!/usr/bin/env bun
/**
 * Runs every `bun run test:*` step listed in the `test:suite` package script.
 *
 * Setup steps run first and in order; the remaining steps run in a bounded
 * parallel pool (each step is its own process with its own temp dirs). Output is
 * buffered per step and printed when the step finishes so logs stay readable.
 *
 * Usage: bun scripts/run-test-suite.ts [--serial] [--concurrency=N]
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// Steps that prepare shared state for later steps. They must finish before the pool starts.
const SETUP_STEPS = new Set(['test:helper-dce', 'test:version-detection:setup'])

interface StepResult {
  name: string
  code: number
  durationMs: number
  output: string
}

function readSuiteSteps(): string[] {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'))
  const suite: string | undefined = pkg.scripts?.['test:suite']
  if (!suite)
    throw new Error('Missing `test:suite` script in cli/package.json')

  return suite.split('&&').map((part) => {
    const match = part.trim().match(/^bun run (\S+)$/)
    if (!match)
      throw new Error(`Unsupported step in test:suite: "${part.trim()}" (expected "bun run <script>")`)
    if (!pkg.scripts[match[1]])
      throw new Error(`test:suite references missing script "${match[1]}"`)
    return match[1]
  })
}

function runStep(name: string): Promise<StepResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', name], {
      cwd: join(import.meta.dir, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => chunks.push(chunk))
    child.on('close', (code, signal) => {
      resolve({
        name,
        code: code ?? (signal ? 1 : 0),
        durationMs: Date.now() - startedAt,
        output: Buffer.concat(chunks).toString('utf8'),
      })
    })
  })
}

function report(result: StepResult) {
  const seconds = (result.durationMs / 1000).toFixed(1)
  const status = result.code === 0 ? 'PASS' : 'FAIL'
  const inCi = Boolean(process.env.GITHUB_ACTIONS)
  if (inCi)
    console.log(`::group::${status} ${result.name} (${seconds}s)`)
  else
    console.log(`\n── ${status} ${result.name} (${seconds}s)`)
  if (result.code !== 0 || inCi || process.env.CLI_TEST_VERBOSE)
    process.stdout.write(result.output)
  if (inCi)
    console.log('::endgroup::')
}

async function main() {
  const args = process.argv.slice(2)
  const serial = args.includes('--serial')
  const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='))
  const concurrency = serial
    ? 1
    : Math.max(1, Number(concurrencyArg?.split('=')[1] ?? process.env.CLI_TEST_CONCURRENCY ?? availableParallelism()))

  const steps = readSuiteSteps()
  const setup = steps.filter(step => SETUP_STEPS.has(step))
  const pool = steps.filter(step => !SETUP_STEPS.has(step))
  const startedAt = Date.now()
  const results: StepResult[] = []

  for (const step of setup) {
    const result = await runStep(step)
    report(result)
    results.push(result)
    if (result.code !== 0) {
      console.error(`Setup step ${step} failed; aborting.`)
      process.exit(1)
    }
  }

  console.log(`Running ${pool.length} test steps with concurrency ${concurrency}`)
  let next = 0
  async function worker() {
    while (next < pool.length) {
      const step = pool[next++]
      const result = await runStep(step)
      report(result)
      results.push(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pool.length) }, worker))

  const failed = results.filter(result => result.code !== 0)
  const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)
  console.log(`\nSlowest steps:\n${slowest.map(r => `  ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  ${r.name}`).join('\n')}`)
  console.log(`\n${results.length - failed.length}/${results.length} steps passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  if (failed.length > 0) {
    console.error(`Failed steps:\n${failed.map(r => `  ${r.name}`).join('\n')}`)
    process.exit(1)
  }
}

await main()
