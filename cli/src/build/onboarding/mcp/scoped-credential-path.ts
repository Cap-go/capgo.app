import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, resolve, sep } from 'node:path'

/** Google Play service-account JSON keys are small; cap well above typical size. */
export const MAX_SERVICE_ACCOUNT_JSON_BYTES = 64 * 1024
/** App Store Connect .p8 PEM files are a few hundred bytes; allow headroom. */
export const MAX_P8_BYTES = 8 * 1024

export type ScopedCredentialKind = 'service-account-json' | 'p8'

export class ScopedCredentialPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopedCredentialPathError'
  }
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
    refuse(userPath, 'path must stay inside the project directory')

  const ext = extname(canonicalPath).toLowerCase()
  const requiredExt = kind === 'service-account-json' ? '.json' : '.p8'
  if (ext !== requiredExt)
    refuse(userPath, `file must have a ${requiredExt} extension`)

  const maxBytes = kind === 'service-account-json' ? MAX_SERVICE_ACCOUNT_JSON_BYTES : MAX_P8_BYTES
  if (st.size > maxBytes)
    refuse(userPath, 'file is too large')
  if (st.size === 0)
    refuse(userPath, 'file is empty')

  const bytes = await readFile(canonicalPath)
  if (kind === 'service-account-json')
    assertServiceAccountShape(bytes, userPath)
  else
    assertP8Shape(bytes, userPath)

  return bytes
}

/**
 * MCP onboarding `readFile` dep: credential extensions use scoped validation;
 * other paths keep the legacy direct read (keystore, mobileprovision, etc.).
 */
export function makeMcpScopedReadFile(scopeRoot: string): (path: string) => Promise<Buffer> {
  return async (path: string) => {
    const ext = extname(path).toLowerCase()
    if (ext === '.json')
      return readScopedMcpCredentialFile(path, 'service-account-json', scopeRoot)
    if (ext === '.p8')
      return readScopedMcpCredentialFile(path, 'p8', scopeRoot)
    return await readFile(path)
  }
}
