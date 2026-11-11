import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, resolve, sep } from 'node:path'

/** Google Play service-account JSON keys are small; cap well above typical size. */
export const MAX_SERVICE_ACCOUNT_JSON_BYTES = 64 * 1024
/** App Store Connect .p8 PEM files are a few hundred bytes; allow headroom. */
export const MAX_P8_BYTES = 8 * 1024
/** Android keystores (.jks / .keystore / .p12) for MCP-provided paths. */
export const MAX_KEYSTORE_BYTES = 4 * 1024 * 1024
/** Provisioning profiles are small XML/plist payloads. */
export const MAX_MOBILEPROVISION_BYTES = 256 * 1024

export const MCP_IN_PROJECT_PATH_HINT = 'Copy the file into the project directory (for example ./credentials/your-file) and use that relative path.'

export type ScopedCredentialKind = 'service-account-json' | 'p8' | 'keystore' | 'mobileprovision'

export class ScopedCredentialPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopedCredentialPathError'
  }
}

const KIND_CONFIG: Record<ScopedCredentialKind, { extensions: readonly string[], maxBytes: number }> = {
  'service-account-json': { extensions: ['.json'], maxBytes: MAX_SERVICE_ACCOUNT_JSON_BYTES },
  'p8': { extensions: ['.p8'], maxBytes: MAX_P8_BYTES },
  'keystore': { extensions: ['.jks', '.keystore', '.p12'], maxBytes: MAX_KEYSTORE_BYTES },
  'mobileprovision': { extensions: ['.mobileprovision'], maxBytes: MAX_MOBILEPROVISION_BYTES },
}

function refuse(userPath: string, detail: string): never {
  throw new ScopedCredentialPathError(`Refusing to read credential file at ${userPath}: ${detail}`)
}

function pathInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function assertServiceAccountShape(bytes: Buffer, userPath: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  }
  catch {
    refuse(userPath, 'invalid service account JSON shape')
  }
  if (!parsed || typeof parsed !== 'object')
    refuse(userPath, 'invalid service account JSON shape')
  const obj = parsed as Record<string, unknown>
  if (
    obj.type !== 'service_account'
    || typeof obj.client_email !== 'string'
    || obj.client_email.length === 0
    || typeof obj.private_key !== 'string'
    || obj.private_key.length === 0
  ) {
    refuse(userPath, 'invalid service account JSON shape')
  }
}

function assertP8Shape(bytes: Buffer, userPath: string): void {
  const text = bytes.toString('utf8')
  if (!text.includes('-----BEGIN PRIVATE KEY-----'))
    refuse(userPath, 'invalid .p8 key shape')
}

function validateShape(kind: ScopedCredentialKind, bytes: Buffer, userPath: string): void {
  if (kind === 'service-account-json')
    assertServiceAccountShape(bytes, userPath)
  else if (kind === 'p8')
    assertP8Shape(bytes, userPath)
}

/**
 * Read a user-supplied credential file for the MCP builder onboarding engine.
 * Confines paths to `scopeRoot` (the engine cwd / Capacitor project directory).
 */
export async function readScopedMcpCredentialFile(
  userPath: string,
  kind: ScopedCredentialKind,
  scopeRoot: string,
): Promise<Buffer> {
  if (!userPath)
    refuse(userPath, 'invalid path')

  const { extensions, maxBytes } = KIND_CONFIG[kind]

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(scopeRoot)
  }
  catch {
    refuse(userPath, 'project directory is unavailable')
  }

  const resolvedInput = isAbsolute(userPath) ? userPath : resolve(scopeRoot, userPath)

  let st
  try {
    st = await lstat(resolvedInput)
  }
  catch {
    refuse(userPath, 'file not found or not readable')
  }

  if (st.isSymbolicLink())
    refuse(userPath, 'symbolic links are not allowed')
  if (!st.isFile())
    refuse(userPath, 'path must be a regular file')

  let canonicalPath: string
  try {
    canonicalPath = await realpath(resolvedInput)
  }
  catch {
    refuse(userPath, 'file not found or not readable')
  }

  if (!pathInsideRoot(canonicalRoot, canonicalPath))
    refuse(userPath, MCP_IN_PROJECT_PATH_HINT)

  const ext = extname(canonicalPath).toLowerCase()
  if (!extensions.includes(ext))
    refuse(userPath, `file must have one of these extensions: ${extensions.join(', ')}`)

  if (st.size > maxBytes)
    refuse(userPath, 'file is too large')
  if (st.size === 0)
    refuse(userPath, 'file is empty')

  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile())
      refuse(userPath, 'path must be a regular file')
    if (opened.size > maxBytes)
      refuse(userPath, 'file is too large')
    const readCap = Math.min(opened.size, maxBytes)
    const bytes = Buffer.alloc(readCap)
    const { bytesRead } = await handle.read(bytes, 0, readCap, 0)
    if (bytesRead < readCap)
      refuse(userPath, 'file not found or not readable')
    const out = bytes.subarray(0, bytesRead)
    validateShape(kind, out, userPath)
    return out
  }
  finally {
    await handle.close()
  }
}
