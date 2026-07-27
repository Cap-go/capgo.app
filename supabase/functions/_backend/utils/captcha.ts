import type { Context } from 'hono'
import { z } from 'zod'
import { safeParseSchema } from './schema_validation.ts'
import { simpleError } from './hono.ts'
import { cloudlog } from './logging.ts'

const captchaSchema = z.object({
  success: z.boolean(),
})

export async function verifyCaptchaToken(c: Context, token: string, captchaSecret: string) {
  const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
  const result = await fetch(url, {
    body: new URLSearchParams({
      secret: captchaSecret,
      response: token,
    }),
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })

  const captchaResult = await result.json()
  const captchaResultData = safeParseSchema(captchaSchema, captchaResult)
  if (!captchaResultData.success) {
    throw simpleError('invalid_captcha', 'Invalid captcha result')
  }
  cloudlog({ requestId: c.get('requestId'), context: 'captcha_result', captchaResultData })
  if (captchaResultData.data.success !== true) {
    throw simpleError('invalid_captcha', 'Invalid captcha result')
  }
}
