import { invokeCapgoApi } from './capgoApi'

interface RegistrationResult {
  user: { id: string }
  session: { access_token: string, refresh_token: string }
}

export async function registerAccount(email: string, password: string, captchaToken?: string): Promise<RegistrationResult> {
  const { data, error } = await invokeCapgoApi<RegistrationResult>('auth/register', {
    method: 'POST',
    allowAnonymous: true,
    body: {
      email,
      password,
      ...(captchaToken ? { captcha_token: captchaToken } : {}),
      opt_for_newsletters: true,
    },
  })
  if (error)
    throw error
  if (!data?.user?.id || !data.session?.access_token || !data.session?.refresh_token)
    throw new Error('Registration returned an incomplete session')
  return data
}
