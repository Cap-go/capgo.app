import { Container } from '@cloudflare/containers'

interface Env {
  GOTRUE: DurableObjectNamespace<GoTrue>
}

// Every string var and secret of this Worker is GoTrue configuration (vars in
// wrangler.jsonc, secrets from internal/cloudflare_gotrue_auth/.env.prod).
function goTrueEnv(env: object): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export class GoTrue extends Container<Env> {
  defaultPort = 9999
  // GoTrue runs its migrations on every start, so keep it warm.
  sleepAfter = '24h'

  constructor(ctx: Container['ctx'], env: Env) {
    super(ctx, env)
    this.envVars = goTrueEnv(env)
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
