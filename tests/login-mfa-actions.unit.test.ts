import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const loginSource = readFileSync(new URL('../src/pages/login.vue', import.meta.url), 'utf8')

describe('login MFA actions', () => {
  it.concurrent('shows only the verify action during the MFA step', () => {
    expect(loginSource).toContain('<div v-show="passwordPathReady && isLoginStep">')
    expect(loginSource).toContain('<div v-show="statusAuth === \'2fa\'">')
  })
})
