#!/usr/bin/env bun
// `bun run backend` after `supabase:start`: the Supabase edge functions and the
// Cloudflare Workers side by side, with queue wakeups going through the local
// QueueDispatcher like prod. Stops both when either one exits or on Ctrl+C.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Each child gets its own process group: both are wrappers (supabase-worktree.ts
// runs the Supabase CLI with spawnSync), so stopping only the wrapper would leave
// the real server running. Signals go to the whole group instead.
const children: ChildProcess[] = [
  spawn('bun', ['scripts/supabase-worktree.ts', 'functions', 'serve'], { cwd: ROOT, stdio: 'inherit', detached: true }),
  spawn('./scripts/start-cloudflare-workers.sh', [], {
    cwd: ROOT,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, LOCAL_QUEUE_DISPATCHER: 'true' },
  }),
]

let exitCode: number | undefined
let interrupted = false
const stopAll = (signal: NodeJS.Signals) => {
  for (const child of children) {
    if (!child.pid)
      continue
    try {
      // Also after the wrapper exited: the group can still hold the real server.
      process.kill(-child.pid, signal)
    }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
        throw error
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    interrupted = true
    stopAll(signal)
  })
}

await Promise.all(children.map(child => new Promise<void>((resolveExit) => {
  child.once('exit', (code) => {
    // The first process to stop decides the exit code and takes the other down.
    exitCode ??= interrupted ? 0 : code ?? 1
    stopAll('SIGTERM')
    resolveExit()
  })
  child.once('error', (error) => {
    console.error(error)
    exitCode ??= 1
    stopAll('SIGTERM')
    resolveExit()
  })
})))

process.exit(exitCode ?? 0)
