import { describe, expect, it } from 'vitest'
import { advisoryInlineParts, parseSecurityAdvisoryMarkdown } from '../src/utils/securityAdvisoryMarkdown.ts'

describe('advisoryInlineParts', () => {
  it.concurrent('drops unsafe links but keeps label text', () => {
    const parts = advisoryInlineParts('[bad](javascript:alert(1))')
    expect(parts).toEqual([{ kind: 'text', text: 'bad' }])
  })

  it.concurrent('keeps https links', () => {
    const parts = advisoryInlineParts('[docs](https://capgo.app/security/)')
    expect(parts[0]).toEqual({
      kind: 'link',
      text: 'docs',
      href: 'https://capgo.app/security/',
    })
  })
})

describe('parseSecurityAdvisoryMarkdown', () => {
  it.concurrent('parses headings and bullet lists', () => {
    const blocks = parseSecurityAdvisoryMarkdown('## Title\n\n- run `npm update`\n- second item')
    expect(blocks[0]?.kind).toBe('heading')
    expect(blocks.find(block => block.kind === 'list')).toMatchObject({ kind: 'list', ordered: false })
  })
})
