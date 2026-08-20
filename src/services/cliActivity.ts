export function shouldShowCLIActivity(payload: { channel: string }): boolean {
  return payload.channel !== 'user-login'
}
