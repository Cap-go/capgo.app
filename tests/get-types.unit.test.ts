import { execFile as execFileCallback } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

describe('Supabase type generation', () => {
  it.concurrent('exits unsuccessfully when the generation target is invalid', async () => {
    await expect(execFile('bun', ['scripts/getTypes.mjs'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        BRANCH: 'main',
        SUPABASE_URL: 'not-a-valid-url',
      },
    })).rejects.toMatchObject({ code: 1 })
  })
})
