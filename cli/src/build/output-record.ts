import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process, { cwd } from 'node:process'
import QRCode from 'qrcode'

/** Stable shape written to disk; bump schemaVersion if breaking changes are made. */
export interface BuildOutputRecord {
  schemaVersion: 1
  jobId: string
  appId: string
  platform: 'ios' | 'android'
  buildMode: 'debug' | 'release'
  status: string
  outputUrl: string | null
  /** Debug symbols for crash reporters: iOS dSYMs zip or Android R8/ProGuard mapping.txt. */
  symbolsUrl: string | null
  qrCodeAscii: string | null
  qrCodePngPath: string | null
  finishedAt: string
}

export interface WriteBuildOutputRecordInput {
  jobId: string
  appId: string
  platform: 'ios' | 'android'
  buildMode: 'debug' | 'release'
  status: string
  outputUrl: string | null
  symbolsUrl?: string | null
}

// Line the builder prints once the debug symbols are uploaded (with --output-upload or --symbols-upload).
const DEBUG_SYMBOLS_LINE = /Debug symbols for crash reporting \([^)]*\): (https?:\/\/\S+)/

/** Download URL of the debug symbols from a build log line, or null. */
export function parseDebugSymbolsUrl(line: string): string | null {
  return DEBUG_SYMBOLS_LINE.exec(line)?.[1] ?? null
}

/**
 * Write a build-output record to `recordPath` (JSON) and, when a URL is available,
 * a PNG QR code to `<recordPath>.qr.png`. Returns the parsed record exactly as
 * written so callers can log a summary without re-reading the file.
 *
 * Failures rendering the PNG are non-fatal — the JSON is always written. The
 * record's `qrCodePngPath` field is null when the PNG could not be produced.
 *
 * Hardening (hostile-review 2026-06-12): the record and PNG paths are unlinked
 * before writing so a pre-planted symlink is replaced instead of followed; the
 * record is written with mode 0600 (outputUrl is a signed download URL); a
 * created parent directory gets mode 0700; and when the record lives under the
 * shared tmpdir, a parent directory that is a symlink or owned by another user
 * is refused.
 */
export async function writeBuildOutputRecord(
  recordPath: string,
  input: WriteBuildOutputRecordInput,
  onWarn?: (msg: string) => void,
): Promise<BuildOutputRecord> {
  const absoluteRecordPath = resolve(cwd(), recordPath)
  const pngPath = `${absoluteRecordPath}.qr.png`
  const parentDir = dirname(absoluteRecordPath)

  // Create the parent directory once up-front so QRCode.toFile (called before
  // the JSON write below) does not fail with ENOENT for callers who passed
  // --output-record under a not-yet-created directory.
  await mkdir(parentDir, { recursive: true, mode: 0o700 })

  // Shared-tmpdir attack surface: another local user pre-creating the per-user
  // record directory (or planting a symlink there) must not be able to capture
  // or redirect the record. Outside tmpdir the directory is the caller's own
  // choice (--output-record) and is not checked.
  if (absoluteRecordPath.startsWith(tmpdir())) {
    const dirStat = await lstat(parentDir)
    if (dirStat.isSymbolicLink())
      throw new Error(`Refusing to write the build record: ${parentDir} is a symbolic link.`)
    if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid())
      throw new Error(`Refusing to write the build record: ${parentDir} is owned by another user.`)
  }

  // Replace (never follow) anything already sitting at the record/PNG paths —
  // rm on a symlink removes the link itself, not its target.
  await rm(absoluteRecordPath, { force: true })
  await rm(pngPath, { force: true })

  let qrCodeAscii: string | null = null
  let qrCodePngPath: string | null = null
  if (input.outputUrl) {
    try {
      qrCodeAscii = await QRCode.toString(input.outputUrl, { type: 'utf8', errorCorrectionLevel: 'L' })
    }
    catch (error) {
      onWarn?.(`Failed to render ASCII QR code: ${stringifyError(error)}`)
    }
    try {
      await QRCode.toFile(pngPath, input.outputUrl, { errorCorrectionLevel: 'L', width: 512 })
      // The PNG encodes the same signed URL as the JSON — owner-only too.
      await chmod(pngPath, 0o600)
      qrCodePngPath = pngPath
    }
    catch (error) {
      onWarn?.(`Failed to render PNG QR code at ${pngPath}: ${stringifyError(error)}`)
    }
  }

  const record: BuildOutputRecord = {
    schemaVersion: 1,
    jobId: input.jobId,
    appId: input.appId,
    platform: input.platform,
    buildMode: input.buildMode,
    status: input.status,
    outputUrl: input.outputUrl ?? null,
    symbolsUrl: input.symbolsUrl ?? null,
    qrCodeAscii,
    qrCodePngPath,
    finishedAt: new Date().toISOString(),
  }

  await writeFile(absoluteRecordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })

  return record
}

/**
 * Returns a deterministic temp-file path for the build output record for a
 * given (appId, platform) pair. Both the build hand-off (command emit) and
 * the confirm (record read) call this helper so that the path is never passed
 * back and forth across an MCP boundary.
 *
 * appId is sanitized: all `/` and `\` characters are replaced with `_`, and
 * any `..` sequences are replaced with `_`, to prevent path traversal.
 *
 * The record lives in a per-user `capgo-build-records-<uid>` subdirectory
 * (created with mode 0700 by `writeBuildOutputRecord`) so that on shared-tmp
 * systems another user can neither pre-create nor read the record file
 * (hostile-review 2026-06-12).
 */
export function defaultBuildRecordPath(appId: string, platform: 'ios' | 'android'): string {
  const safe = appId.replace(/[/\\]/g, '_').replace(/\.\./g, '_')
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'default'
  return join(tmpdir(), `capgo-build-records-${uid}`, `capgo-build-record-${safe}-${platform}.json`)
}

/**
 * Remove a build output record and its companion QR PNG. Absent paths are a
 * no-op. Called before a new build hand-off so a record left behind by an
 * earlier build can never be read as the new build's result.
 */
export async function removeBuildOutputRecord(recordPath: string): Promise<void> {
  await rm(recordPath, { force: true })
  await rm(`${recordPath}.qr.png`, { force: true })
}

/**
 * Thrown by `readBuildOutputRecord` when the record file EXISTS but cannot be
 * used: unreadable (permissions), a symbolic link, not valid JSON (e.g. a
 * truncated write), or an unexpected shape. Distinct from the `null` return
 * (no record yet) so callers polling for a build result can surface the
 * failure instead of waiting forever.
 */
export class BuildRecordReadError extends Error {
  readonly recordPath: string
  constructor(message: string, recordPath: string) {
    super(message)
    this.name = 'BuildRecordReadError'
    this.recordPath = recordPath
  }
}

/**
 * Read a build output record from `path`.
 *
 * Returns `null` ONLY when the file does not exist yet (ENOENT — the build has
 * not finished). Every other failure mode (unreadable file, a symlink at the
 * record path, malformed JSON, missing/wrong-type fields) throws
 * `BuildRecordReadError`: a present-but-corrupt record is a surfaced failure,
 * never "still waiting".
 *
 * Shape rules (hostile-review 2026-06-12):
 *  - every record owes the `jobId`/`status`/`outputUrl` trio (forward-tolerant
 *    baseline for future schemaVersions);
 *  - a `schemaVersion: 1` record is validated strictly against the full
 *    `BuildOutputRecord` shape — the v1 writer has always emitted it, and
 *    checkBuild correlates `appId`/`platform` against the build it launched.
 */
export async function readBuildOutputRecord(path: string): Promise<BuildOutputRecord | null> {
  // lstat first: a symlink at the record path is refused, never followed.
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink())
      throw new BuildRecordReadError(`Build record at ${path} is a symbolic link — refusing to follow it.`, path)
  }
  catch (error) {
    if (error instanceof BuildRecordReadError)
      throw error
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
      return null
    throw new BuildRecordReadError(`Build record at ${path} could not be read: ${stringifyError(error)}`, path)
  }

  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
      return null
    throw new BuildRecordReadError(`Build record at ${path} could not be read: ${stringifyError(error)}`, path)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw new BuildRecordReadError(`Build record at ${path} is not valid JSON (possibly a truncated write): ${stringifyError(error)}`, path)
  }

  if (typeof parsed !== 'object' || parsed === null)
    throw new BuildRecordReadError(`Build record at ${path} has an unexpected shape (not a JSON object).`, path)

  const r = parsed as Record<string, unknown>
  const baseOk = typeof r.jobId === 'string'
    && typeof r.status === 'string'
    && (r.outputUrl === null || typeof r.outputUrl === 'string')
  if (!baseOk)
    throw new BuildRecordReadError(`Build record at ${path} has an unexpected shape (jobId/status must be strings; outputUrl must be a string or null).`, path)

  if (r.schemaVersion === 1) {
    const v1Ok = typeof r.appId === 'string'
      && (r.platform === 'ios' || r.platform === 'android')
      && (r.buildMode === 'debug' || r.buildMode === 'release')
      && typeof r.finishedAt === 'string'
      && (r.qrCodeAscii === null || typeof r.qrCodeAscii === 'string')
      && (r.qrCodePngPath === null || typeof r.qrCodePngPath === 'string')
    if (!v1Ok)
      throw new BuildRecordReadError(`Build record at ${path} declares schemaVersion 1 but is missing or mistyping required v1 fields (appId/platform/buildMode/finishedAt/qrCodeAscii/qrCodePngPath).`, path)
  }

  return parsed as BuildOutputRecord
}

function stringifyError(error: unknown): string {
  if (error instanceof Error)
    return error.message
  return String(error)
}
