import { describe, expect, it } from 'vitest'
import { getLoginActionVisibility } from '../src/utils/loginActions'

describe('login MFA actions', () => {
  it.concurrent('shows exactly one action for each ready authentication step', () => {
    expect(getLoginActionVisibility('login', true)).toEqual({ login: true, verify: false })
    expect(getLoginActionVisibility('2fa', true)).toEqual({ login: false, verify: true })
  })
})
