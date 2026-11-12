import { Container } from '@cloudflare/containers'

interface Env {
  GOTRUE: DurableObjectNamespace<GoTrue>
  CAPTCHA_SECRET_KEY?: SecretsStoreSecret
  [key: string]: unknown
}

// Every string var and secret of this Worker is GoTrue configuration (vars in
// wrangler.jsonc, secrets from internal/cloudflare_gotrue_auth/.env.prod).
// Turnstile comes from the CAPTCHA_SECRET_KEY Secrets Store binding.
function goTrueStringEnv(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      if (entry[0] === 'GOTRUE' || entry[0] === 'CAPTCHA_SECRET_KEY')
        return false
      return typeof entry[1] === 'string'
    }),
  )
}

export class GoTrue extends Container<Env> {
  defaultPort = 9999
  // GoTrue runs its migrations on every start, so keep it warm.
  sleepAfter = '24h'

  private envReady?: Promise<void>

  constructor(ctx: Container['ctx'], env: Env) {
    super(ctx, env)
    this.envVars = goTrueStringEnv(env)
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureContainerEnv()
    return super.fetch(request)
  }

  private ensureContainerEnv() {
    if (!this.envReady) {
      this.envReady = this.applyCaptchaSecret().catch((error) => {
        this.envReady = undefined
        throw error
      })
    }
    return this.envReady
  }

  private async applyCaptchaSecret() {
    const binding = this.env.CAPTCHA_SECRET_KEY
    if (!binding)
      return
    const secret = await binding.get()
    if (!secret)
      return
    this.envVars = { ...(this.envVars ?? {}), GOTRUE_SECURITY_CAPTCHA_SECRET: secret }
  }
}

// No route and no workers.dev URL: only the API Worker's service binding
// (console auth relay) reaches this handler.
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const id = env.GOTRUE.idFromName('gotrue')
    return env.GOTRUE.get(id, { locationHint: 'weur' }).fetch(request)
  },
}
