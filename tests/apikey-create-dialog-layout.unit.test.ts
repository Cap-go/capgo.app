import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const apiKeysPageSource = readFileSync(new URL('../src/pages/ApiKeys.vue', import.meta.url), 'utf8')

describe('api key create dialog layout', () => {
  it.concurrent('does not reveal the name error on the blur caused by the first click elsewhere', () => {
    // DialogV2 autofocuses the name field. A "required" message rendered on blur pushes the
    // org dropdown down between mousedown and mouseup, so the click lands on its wrapper.
    const nameField = apiKeysPageSource.slice(
      apiKeysPageSource.indexOf('data-test="create-key-name"'),
      apiKeysPageSource.indexOf('/>', apiKeysPageSource.indexOf('data-test="create-key-name"')),
    )
    expect(nameField).toContain('validation="required|length:1,32"')
    expect(nameField).toContain('validation-visibility="dirty"')
  })
})
