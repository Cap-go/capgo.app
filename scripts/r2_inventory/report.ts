import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeFailureReport(path: string, report: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    await file.chmod(0o600)
    await file.writeFile(`${JSON.stringify(report)}\n`)
  }
  finally {
    await file.close()
  }
}
