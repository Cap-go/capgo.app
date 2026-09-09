import { describe, expect, it } from 'vitest'
import { resolveLatestDeployTag } from '../scripts/resolve-deploy-tag.ts'

const stableSha = '1111111111111111111111111111111111111111'
const alphaSha = '2222222222222222222222222222222222222222'

describe('latest deployment tag resolution', () => {
  it.concurrent('selects the most recently created stable tag despite an older higher version', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'tag --list capgo-[0-9]* --sort=-version:refname --sort=-creatordate': 'capgo-12.10.0\ncapgo-13.0.0\ncapgo-13.0.0-alpha.2',
        'rev-list -n 1 capgo-12.10.0': stableSha,
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveLatestDeployTag(false, run)).toEqual({
      isAlpha: false,
      sha: stableSha,
      tag: 'capgo-12.10.0',
    })
    expect(calls[0]).toEqual([
      'tag',
      '--list',
      'capgo-[0-9]*',
      '--sort=-version:refname',
      '--sort=-creatordate',
    ])
  })

  it.concurrent('selects the newest alpha Capgo tag', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'tag --list capgo-[0-9]* --sort=-version:refname --sort=-creatordate': 'capgo-12.10.0-alpha.4\ncapgo-13.0.0-alpha.10\ncapgo-12.10.0',
        'rev-list -n 1 capgo-12.10.0-alpha.4': alphaSha,
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveLatestDeployTag(true, run)).toEqual({
      isAlpha: true,
      sha: alphaSha,
      tag: 'capgo-12.10.0-alpha.4',
    })
  })

  it.concurrent('rejects a missing deployment target', () => {
    expect(() => resolveLatestDeployTag(false, () => '')).toThrow(
      'No stable Capgo deployment tag was found',
    )
  })

  it.concurrent.each([
    [false, 'capgo-12.0'],
    [true, 'capgo-12.0.0-alpha.latest'],
  ])('rejects malformed deployment tags before checkout', (includePrereleaseTags, tag) => {
    const run = (args: string[]) => {
      if (args[0] === 'tag')
        return tag

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => resolveLatestDeployTag(includePrereleaseTags, run)).toThrow(
      `Malformed Capgo deployment tag: ${tag}`,
    )
  })

  it.concurrent('rejects a target that does not resolve to a full commit SHA', () => {
    const run = (args: string[]) => {
      if (args[0] === 'tag')
        return 'capgo-12.10.0'
      if (args[0] === 'rev-list')
        return 'deadbeef'

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => resolveLatestDeployTag(false, run)).toThrow(
      'did not resolve to a full commit SHA',
    )
  })
})
