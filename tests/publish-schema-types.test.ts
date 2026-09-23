import { describe, expect, it } from 'vitest'
import { publishSchemaTypes } from '../scripts/publish-schema-types.ts'

const expectedSha = '1111111111111111111111111111111111111111'
const generatedSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const newerSha = '2222222222222222222222222222222222222222'

describe('schema/types compare-and-swap publication', () => {
  it.concurrent('rejects remotes that start with a hyphen', () => {
    expect(() => publishSchemaTypes({
      branch: 'main',
      expectedBranchSha: expectedSha,
      remote: '--upload-pack=evil',
    })).toThrow('Schema/types remote must be non-empty, contain no line breaks, and not start with "-"')
  })

  it.concurrent('returns retry without pushing when main moved before publication', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      if (args[0] === 'ls-remote')
        return `${newerSha}\trefs/heads/main`

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(publishSchemaTypes({
      branch: 'main',
      expectedBranchSha: expectedSha,
      remote: 'origin',
    }, run)).toBe('retry')
    expect(calls.some(args => args[0] === 'push')).toBe(false)
  })

  it.concurrent('publishes the prepared schema/types commit with an atomic branch push', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'ls-remote --heads origin refs/heads/main': `${expectedSha}\trefs/heads/main`,
        'push --atomic origin HEAD:refs/heads/main': '',
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(publishSchemaTypes({
      branch: 'main',
      expectedBranchSha: expectedSha,
      remote: 'origin',
    }, run)).toBe('published')
    expect(calls).toContainEqual([
      'push',
      '--atomic',
      'origin',
      'HEAD:refs/heads/main',
    ])
  })

  it.concurrent('returns retry when a rejected push lost a race with newer main', () => {
    let remoteReads = 0
    const pushError = new Error('non-fast-forward')
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote') {
        remoteReads += 1
        const sha = remoteReads === 1 ? expectedSha : newerSha
        return `${sha}\trefs/heads/main`
      }
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return generatedSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(publishSchemaTypes({
      branch: 'main',
      expectedBranchSha: expectedSha,
      remote: 'origin',
    }, run)).toBe('retry')
    expect(remoteReads).toBe(2)
  })

  it.concurrent('treats a lost push response as published when remote main matches local HEAD', () => {
    let remoteReads = 0
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote') {
        remoteReads += 1
        const sha = remoteReads === 1 ? expectedSha : generatedSha
        return `${sha}\trefs/heads/main`
      }
      if (args[0] === 'push')
        throw new Error('network timeout')
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return generatedSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(publishSchemaTypes({
      branch: 'main',
      expectedBranchSha: expectedSha,
      remote: 'origin',
    }, run)).toBe('published')
  })

  it.concurrent('preserves genuine push failures while main remains unchanged', () => {
    const pushError = new Error('permission denied')
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote')
        return `${expectedSha}\trefs/heads/main`
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return generatedSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => publishSchemaTypes({
      branch: 'main',
      expectedBranchSha: expectedSha,
      remote: 'origin',
    }, run)).toThrow(pushError)
  })
})
