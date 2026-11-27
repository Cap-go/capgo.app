import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRunCommandScript } from '../cloudflare_workers/terminal/lib/run_command.ts'

// Real `sh` + `setsid` behavior test for the run_command wrapper (Linux only, like the container).
const PROMPT_MS = 5_000

interface RunResult {
  stdout: string
  code: number | null
  signal: NodeJS.Signals | null
  closed: boolean
  elapsedMs: number
}

const spawned: ChildProcess[] = []
const pidFiles: string[] = []
const tmpDirs: string[] = []

function newPidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-run-command-'))
  tmpDirs.push(dir)
  const file = join(dir, 'bg.pid')
  pidFiles.push(file)
  return file
}

function readPid(file: string): number {
  return Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
}

function isAlive(pid: number): boolean {
  const statPath = `/proc/${pid}/stat`
  if (!existsSync(statPath))
    return false
  try {
    const stat = readFileSync(statPath, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z' && state !== 'X'
  }
  catch {
    return false
  }
}

async function waitDead(pid: number, ms = 1_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!isAlive(pid))
      return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return !isAlive(pid)
}

function run(script: string, onStdout?: (child: ChildProcess, text: string) => void): Promise<RunResult> {
  const started = Date.now()
  const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(child)
  let stdout = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    onStdout?.(child, stdout)
  })
  return new Promise((resolve) => {
    const cap = setTimeout(() => {
      resolve({ stdout, code: null, signal: null, closed: false, elapsedMs: Date.now() - started })
    }, PROMPT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(cap)
      resolve({ stdout, code, signal, closed: true, elapsedMs: Date.now() - started })
    })
  })
}

afterEach(() => {
  for (const file of pidFiles.splice(0)) {
    try {
      process.kill(readPid(file), 'SIGKILL')
    }
    catch {}
  }
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL')
    }
    catch {}
  }
  for (const dir of tmpDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('run_command process group wrapper', () => {
  it('kills a backgrounded child and returns promptly when the command times out', async () => {
    const pidFile = newPidFile()
    const result = await run(buildRunCommandScript(`sleep 600 & echo $! > ${pidFile}; echo started; sleep 600`, 1_000))

    expect(result.closed).toBe(true)
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS)
    expect(result.stdout).toContain('started')
    expect(result.code).toBe(137)
    expect(await waitDead(readPid(pidFile))).toBe(true)
  })

  it('kills a backgrounded child when the foreground command exits normally', async () => {
    const pidFile = newPidFile()
    const result = await run(buildRunCommandScript(`sleep 600 & echo $! > ${pidFile}; echo done`, 60_000))

    expect(result.closed).toBe(true)
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS)
    expect(result.stdout).toBe('done\n')
    expect(result.code).toBe(0)
    expect(await waitDead(readPid(pidFile))).toBe(true)
  })

  it('kills the whole group when the wrapper is terminated (proc.kill or abort)', async () => {
    const pidFile = newPidFile()
    let sent = false
    const result = await run(
      buildRunCommandScript(`sleep 600 & echo $! > ${pidFile}; echo started; sleep 600`, 60_000),
      (child, text) => {
        if (!sent && text.includes('started')) {
          sent = true
          child.kill('SIGTERM')
        }
      },
    )

    expect(sent).toBe(true)
    expect(result.closed).toBe(true)
    expect(result.elapsedMs).toBeLessThan(PROMPT_MS)
    expect(await waitDead(readPid(pidFile))).toBe(true)
  })

  it('preserves the exit code and single quotes of the user command', async () => {
    const result = await run(buildRunCommandScript(`echo 'a b'; exit 3`, 60_000))

    expect(result.closed).toBe(true)
    expect(result.stdout).toBe('a b\n')
    expect(result.code).toBe(3)
  })
})
