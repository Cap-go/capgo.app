import { randomUUID } from 'node:crypto'
import { appendFile, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface WriteOptions {
  mode?: number
  encoding?: BufferEncoding
}

/**
 * Ensure the target path exists and is not a symbolic link.
 * This prevents symlink-based path traversal and file clobbering.
 */
async function ensureNotSymlink(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to access symbolic link path: ${path}`)
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
}

/**
 * Create (or reuse) a directory and enforce safe permissions.
 */
export async function ensureSecureDirectory(path: string, mode: number): Promise<void> {
  await ensureNotSymlink(path)
  await mkdir(path, { recursive: true, mode })
  const stat = await lstat(path)
  if (!stat.isDirectory())
    throw new Error(`Expected a directory at ${path}`)
  await chmod(path, mode)
}

/**
 * Append content to a file without following symbolic links.
 */
export async function appendToSafeFile(filePath: string, content: string, mode: number = 0o600): Promise<void> {
  await ensureNotSymlink(filePath)
  await appendFile(filePath, content, { mode })
}

/**
 * Write content atomically by writing a temp file and renaming.
 */
export async function writeFileAtomic(filePath: string, content: string, options: WriteOptions = {}): Promise<void> {
  const mode = options.mode ?? 0o600
  await ensureNotSymlink(filePath)

  const tempPath = join(dirname(filePath), `.capgo-tmp-${randomUUID()}`)
  try {
    await writeFile(tempPath, content, { encoding: options.encoding ?? 'utf-8', mode })
    await rename(tempPath, filePath)
  }
  catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

/**
 * Read file content while rejecting symbolic-link targets.
 */
export async function readSafeFile(filePath: string): Promise<string> {
  await ensureNotSymlink(filePath)
  return await readFile(filePath, 'utf-8')
}

/**
 * Read file BYTES while rejecting symbolic-link targets (binary-safe twin of
 * readSafeFile — for credential files like keystores / .p12 / .p8 that are not utf-8).
 */
export async function readSafeFileBytes(filePath: string): Promise<Buffer> {
  await ensureNotSymlink(filePath)
  return await readFile(filePath)
}
