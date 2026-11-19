import { describe, expect, it } from 'vitest'
import zhCnCommittedMessages from '../messages/zh-cn.json'
import { applyCommittedLocaleOverrides } from '../src/modules/i18n'

describe('zh-cn committed china console copy', () => {
  it('ships a Chinese china-console-suggestion string', () => {
    expect(zhCnCommittedMessages['china-console-suggestion']).toMatch(/[\u4e00-\u9fff]/)
    expect(zhCnCommittedMessages['china-console-suggestion']).not.toContain('Having trouble')
  })

  it('overrides remote zh-cn catalog strings for the china banner key', () => {
    const merged = applyCommittedLocaleOverrides('zh-cn', {
      'china-console-suggestion': 'Having trouble reaching the API from your network? Try the China console at',
    })
    expect(merged['china-console-suggestion']).toBe(zhCnCommittedMessages['china-console-suggestion'])
  })
})