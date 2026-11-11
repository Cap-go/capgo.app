import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_P8_BYTES,
  MAX_SERVICE_ACCOUNT_JSON_BYTES,
  readScopedMcpCredentialFile,
  ScopedCredentialPathError,
} from '../../../../src/build/onboarding/mcp/scoped-credential-path.ts'

const VALID_SA = {
  type: 'service_account',
  client_email: 'robot@example.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nLINE\n-----END PRIVATE KEY-----\n',
  project_id: 'demo',
  token_uri: 'https://oauth2.googleapis.com/token',
}

const VALID_P8 = `-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n`

const SECRET_PAYLOAD = 'SUPER_SECRET_FILE_CONTENT_LEAK_TEST'

function makeWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-scoped-cred-')))
  mkdirSync(join(root, 'creds'), { recursive: true })
  writeFileSync(join(root, 'creds', 'sa.json'), JSON.stringify(VALID_SA))
  writeFileSync(join(root, 'creds', 'key.p8'), VALID_P8)
  writeFileSync(join(root, 'secret.txt'), SECRET_PAYLOAD)
  return root
}

describe('readScopedMcpCredentialFile', () => {
  it('happy path: reads valid service account JSON and .p8 inside scope', async () => {
    const root = makeWorkspace()
    const sa = await readScopedMcpCredentialFile('creds/sa.json', 'service-account-json', root)
    expect(sa.toString('utf8')).toContain('robot@example.com')
    const p8 = await readScopedMcpCredentialFile('creds/key.p8', 'p8', root)
    expect(p8.toString('utf8')).toContain('BEGIN PRIVATE KEY')
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects ../ traversal', async () => {
    const root = makeWorkspace()
    await expect(readScopedMcpCredentialFile('../secret.txt', 'service-account-json', root))
      .rejects.toBeInstanceOf(ScopedCredentialPathError)
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects an absolute path outside the scope', async () => {
    const root = makeWorkspace()
    const outside = mkdtempSync(join(tmpdir(), 'capgo-scoped-out-'))
    const outsideFile = join(outside, 'leak.json')
    writeFileSync(outsideFile, JSON.stringify(VALID_SA))
    await expect(readScopedMcpCredentialFile(outsideFile, 'service-account-json', root))
      .rejects.toBeInstanceOf(ScopedCredentialPathError)
    rmSync(outside, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects a symlink to a file outside the scope', async () => {
    const root = makeWorkspace()
    const outside = mkdtempSync(join(tmpdir(), 'capgo-scoped-link-out-'))
    const outsideFile = join(outside, 'leak.json')
    writeFileSync(outsideFile, SECRET_PAYLOAD)
    const linkPath = join(root, 'creds', 'escape.json')
    symlinkSync(outsideFile, linkPath)
    let err: unknown
    try {
      await readScopedMcpCredentialFile(linkPath, 'service-account-json', root)
    }
    catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ScopedCredentialPathError)
    const msg = (err as Error).message
    expect(msg).not.toContain(SECRET_PAYLOAD)
    rmSync(outside, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects a directory', async () => {
    const root = makeWorkspace()
    await expect(readScopedMcpCredentialFile('creds', 'p8', root))
      .rejects.toBeInstanceOf(ScopedCredentialPathError)
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects the wrong extension', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'creds', 'key.txt'), VALID_P8)
    await expect(readScopedMcpCredentialFile('creds/key.txt', 'p8', root))
      .rejects.toBeInstanceOf(ScopedCredentialPathError)
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects an oversize file', async () => {
    const root = makeWorkspace()
    const big = join(root, 'creds', 'big.json')
    writeFileSync(big, `{"type":"service_account","client_email":"a@b.c","private_key":"x","pad":"${'a'.repeat(MAX_SERVICE_ACCOUNT_JSON_BYTES)}"}`)
    await expect(readScopedMcpCredentialFile(big, 'service-account-json', root))
      .rejects.toBeInstanceOf(ScopedCredentialPathError)
    const bigP8 = join(root, 'creds', 'big.p8')
    writeFileSync(bigP8, `${VALID_P8}${'x'.repeat(MAX_P8_BYTES)}`)
    await expect(readScopedMcpCredentialFile(bigP8, 'p8', root))
      .rejects.toBeInstanceOf(ScopedCredentialPathError)
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects bad content shape without echoing file bytes', async () => {
    const root = makeWorkspace()
    const badJson = join(root, 'creds', 'bad.json')
    writeFileSync(badJson, JSON.stringify({ type: 'user', note: SECRET_PAYLOAD }))
    let err: unknown
    try {
      await readScopedMcpCredentialFile(badJson, 'service-account-json', root)
    }
    catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ScopedCredentialPathError)
    expect((err as Error).message).not.toContain(SECRET_PAYLOAD)

    const badP8 = join(root, 'creds', 'bad.p8')
    writeFileSync(badP8, `not a key ${SECRET_PAYLOAD}`)
    let p8Err: unknown
    try {
      await readScopedMcpCredentialFile(badP8, 'p8', root)
    }
    catch (e) {
      p8Err = e
    }
    expect(p8Err).toBeInstanceOf(ScopedCredentialPathError)
    expect((p8Err as Error).message).not.toContain(SECRET_PAYLOAD)
    rmSync(root, { recursive: true, force: true })
  })

  it('error text may include only the user-supplied path', async () => {
    const root = makeWorkspace()
    const userPath = '/outside/nowhere.json'
    let err: unknown
    try {
      await readScopedMcpCredentialFile(userPath, 'service-account-json', root)
    }
    catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ScopedCredentialPathError)
    const msg = (err as Error).message
    expect(msg).toContain(userPath)
    expect(msg).not.toContain(VALID_SA.private_key)
    rmSync(root, { recursive: true, force: true })
  })
})
