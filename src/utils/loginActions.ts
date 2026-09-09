export type LoginAuthStatus = 'login' | '2fa'

export function getLoginActionVisibility(statusAuth: LoginAuthStatus, passwordPathReady: boolean) {
  return {
    login: passwordPathReady && statusAuth === 'login',
    verify: statusAuth === '2fa',
  }
}
