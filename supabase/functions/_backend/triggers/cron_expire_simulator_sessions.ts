import { BRES, createHono, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { sweepDueSimulatorSessions } from '../public/build/concurrency.ts'
import { version } from '../utils/version.ts'

export const app = createHono('', version)

app.post('/', middlewareAPISecret, async (c) => {
  try {
    const result = await sweepDueSimulatorSessions(c)
    return c.json({ ...BRES, ...result })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Simulator idle sweep failed', error })
    throw error
  }
})