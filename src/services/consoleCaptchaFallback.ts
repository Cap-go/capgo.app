import { invokeCapgoApi } from '~/services/capgoApi'

export type ConsoleCaptchaFallbackPurpose = 'magic_link' | 'recover' | 'resend_signup'

export async function requestConsoleCaptchaFallbackEmail(
  email: string,
  purpose: ConsoleCaptchaFallbackPurpose,
  redirectTo?: string,
) {
  return await invokeCapgoApi<{ status: 'ok' }>('private/console/captcha_fallback', {
    method: 'POST',
    body: { email: email.trim(), purpose, redirect_to: redirectTo },
    allowAnonymous: true,
  })
}
