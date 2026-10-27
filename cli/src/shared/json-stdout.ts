import process from 'node:process'

/**
 * Run `fn` while every ambient stdout write (clack logs, dependency output) is
 * routed to stderr, so a `--json` command can print exactly one JSON document
 * on stdout afterwards.
 */
export async function withStdoutOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = function write(chunk: never, encoding?: never, callback?: never): boolean {
    return stderrWrite(chunk, encoding, callback)
  } as typeof process.stdout.write
  try {
    return await fn()
  }
  finally {
    process.stdout.write = originalWrite
  }
}
