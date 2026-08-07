/**
 * Marker for *expected* CLI failures that represent a legitimate user-facing
 * state — missing input, a channel with no bundle linked, insufficient
 * permissions — rather than a crash. The CLI still prints a clear message and
 * exits non-zero, but `shouldCapturePosthogException` skips these so they never
 * open an error tracking `$exception` issue. They are still counted via
 * `trackCommandFailed` / `categorizeCliError`, so failure analytics stay intact.
 *
 * Keep any dynamic identifier (e.g. a channel name) OUT of the message and pass
 * it via `context` instead: interpolating it into the message makes error
 * tracking fingerprint a separate issue per value, which is exactly the noise
 * this class exists to avoid.
 *
 * Precedent for domain-specific error markers already exists in the CLI with
 * `MacOSSigningError` and `BuildRecordReadError`.
 */
export class CliUserError extends Error {
  readonly context?: Record<string, unknown>
  constructor(message: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'CliUserError'
    this.context = context
  }
}
