import type { Buffer } from 'node:buffer'
import { rmSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface CachedManifestPayload {
  fileName: string
  compression: 'none' | 'brotli'
  uploadedBytesSha256: string
  uploadedBytesSize: number
}

/**
 * Keeps the exact bytes prepared for each delta entry (compressed, encrypted)
 * on disk between `prepareManifestUploadEntries` and `uploadPartial`, so the
 * upload step does not compress and encrypt every file a second time and a
 * 10,000-file bundle is never held in memory at once.
 */
export class ManifestPayloadCache {
  private readonly entries = new Map<number, CachedManifestPayload>()
  private disposed = false
  private readonly onExit = () => this.disposeSync()

  private constructor(readonly directory: string) {
    process.once('exit', this.onExit)
  }

  static async create(): Promise<ManifestPayloadCache> {
    return new ManifestPayloadCache(await mkdtemp(join(tmpdir(), 'capgo-delta-')))
  }

  private path(id: number): string {
    return join(this.directory, `${id}`)
  }

  async set(id: number, payload: CachedManifestPayload, bytes: Buffer): Promise<void> {
    if (this.disposed)
      return
    await writeFile(this.path(id), bytes)
    this.entries.set(id, payload)
  }

  get(id: number): CachedManifestPayload | undefined {
    return this.entries.get(id)
  }

  /** The cached bytes, or undefined when this entry was never cached or the file is gone. */
  async read(id: number): Promise<Buffer | undefined> {
    const payload = this.entries.get(id)
    if (!payload || this.disposed)
      return undefined
    try {
      const bytes = await readFile(this.path(id))
      return bytes.byteLength === payload.uploadedBytesSize ? bytes : undefined
    }
    catch {
      return undefined
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed)
      return
    this.disposed = true
    this.entries.clear()
    process.removeListener('exit', this.onExit)
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined)
  }

  private disposeSync(): void {
    if (this.disposed)
      return
    this.disposed = true
    try {
      rmSync(this.directory, { recursive: true, force: true })
    }
    catch {
      // Best effort: the OS cleans its temp directory eventually.
    }
  }
}
