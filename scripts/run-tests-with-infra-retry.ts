import { spawn } from 'node:child_process'
import { argv, env, exit, stderr, stdout } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

export type TransientTestFailure = 'kong_upstream' | 'workerd_restart' | 'gateway_502_503' | 'postgrest_schema_cache'

const TRANSIENT_FAILURE_PATTERNS: ReadonlyArray<readonly [TransientTestFailure, RegExp]> = [
  ['postgrest_schema_cache', /PGRST002[\s\S]*Could not query the database for the schema cache\. Retrying\./],
  ['kong_upstream', /An invalid response was received from the upstream server/],
  ['workerd_restart', /Your worker restarted mid-request/],
  ['gateway_502_503', /AssertionError: expected 50[23] to be \d+/],
]

export function getTransientTestFailure(output: string): TransientTestFailure | null {
  const normalizedOutput = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
  const failedTestStarts = [...normalizedOutput.matchAll(/^\s*FAIL\s+.+$/gm)]
  if (failedTestStarts.length === 0)
    return null

  const failedDiagnosticStarts = failedTestStarts.flatMap((failedTestStart, index) => {
    const previousStart = failedTestStarts[index - 1]
    if (!previousStart)
      return [failedTestStart.index]

    const previousHeaderEnd = previousStart.index + previousStart[0].length
    return normalizedOutput.slice(previousHeaderEnd, failedTestStart.index).trim() === ''
      ? []
      : [failedTestStart.index]
  })

  let classifiedFailure: TransientTestFailure | null = null
  for (let index = 0; index < failedDiagnosticStarts.length; index++) {
    const start = failedDiagnosticStarts[index]
    const end = failedDiagnosticStarts[index + 1] ?? normalizedOutput.length
    const failedDiagnostic = normalizedOutput.slice(start, end)
    const match = TRANSIENT_FAILURE_PATTERNS.find(([, pattern]) => pattern.test(failedDiagnostic))
    if (!match)
      return null
    classifiedFailure ??= match[0]
  }
  return classifiedFailure
}

async function run(command: string[]): Promise<{ exitCode: number, output: string }> {
  const child = spawn(command[0], command.slice(1), {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stdout.write(text)
    output += text
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderr.write(text)
    output += text
  })

  const exitCode = await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      const message = `${error}\n`
      stderr.write(message)
      output += message
      resolve(1)
    })
    child.once('close', code => resolve(code ?? 1))
  })
  return { exitCode, output }
}

async function main(): Promise<void> {
  const scriptArguments = argv.slice(2)
  const command = scriptArguments[0] === '--' ? scriptArguments.slice(1) : scriptArguments
  if (command.length === 0) {
    console.error('Usage: bun scripts/run-tests-with-infra-retry.ts -- <command> [args...]')
    exit(2)
  }

  const firstAttempt = await run(command)
  if (firstAttempt.exitCode === 0)
    return

  const transientFailure = getTransientTestFailure(firstAttempt.output)
  if (!transientFailure) {
    console.error('Test command failed without a recognized infrastructure failure; not retrying.')
    exit(firstAttempt.exitCode)
  }

  const message = `Retrying test command once after transient infrastructure failure: ${transientFailure}`
  if (env.GITHUB_ACTIONS === 'true')
    console.error(`::warning::${message}`)
  else
    console.error(message)

  await delay(2_000)
  const secondAttempt = await run(command)
  exit(secondAttempt.exitCode)
}

if (import.meta.main)
  await main()
