import { Container } from '@cloudflare/containers'
import { goTrueStringEnv } from './container_env.ts'
import { swapServiceKey } from './service_key.ts'

interface Env {
  GOTRUE: DurableObjectNamespace<GoTrue>
  SUPABASE_SERVICE_ROLE_KEY?: string
  [key: string]: unknown
}

export class GoTrue extends Container<Env> {
  defaultPort = 9999
  // GoTrue runs its migrations on every start, so keep it warm.
  sleepAfter = '24h'

  constructor(ctx: Container['ctx'], env: Env) {
    super(ctx, env)
    this.envVars = goTrueStringEnv(env)
  }
}

// No route and no workers.dev URL: only the API Worker's service binding
// (console auth relay, admin calls with the service key) reaches this handler.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.GOTRUE.idFromName('gotrue')
    return env.GOTRUE.get(id, { locationHint: 'weur' }).fetch(await swapServiceKey(request, env))
  },
}
