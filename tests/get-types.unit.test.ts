import { describe, expect, it } from 'vitest'
import { generateTypes } from '../scripts/getTypes.mjs'

describe('Supabase type generation', () => {
  it.concurrent('propagates command generation failures', async () => {
    await expect(generateTypes({
      copy: async () => {},
      execute: async () => {
        throw new Error('generation failed')
      },
      resolveTarget: async () => ['--local'],
      write: async () => {},
    })).rejects.toThrow('generation failed')
  })

  it.concurrent('propagates generated type copy failures', async () => {
    await expect(generateTypes({
      copy: async () => {
        throw new Error('copy failed')
      },
      execute: async () => ({ stderr: '', stdout: 'export interface Database {}' }),
      resolveTarget: async () => ['--local'],
      write: async () => {},
    })).rejects.toThrow('copy failed')
  })
})
