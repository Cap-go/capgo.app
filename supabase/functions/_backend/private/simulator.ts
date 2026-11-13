import type { SimulatorBody } from '../public/build/simulator.ts'
import { Hono } from 'hono/tiny'
import { savedOutputsForJobs } from '../public/build/outputs.ts'
import { ensureBuildPermission, getBuildOwnerOrg } from '../public/build/request.ts'
import { readSimulator, startSimulator, stopSimulator } from '../public/build/simulator.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { authPrincipal } from '../utils/pg_rls.ts'

export const app = new Hono()

app.use('/*', useCors)

function userId(c: { get: (key: 'auth') => { userId?: string } | undefined }) {
  const id = c.get('auth')?.userId
  if (!id)
    throw simpleError('not_authorized', 'Not authorized')
  return id
}

app.get('/outputs', middlewareAuth, async (c) => {
  const appId = c.req.query('app_id') ?? ''
  const jobIds = (c.req.query('job_ids') ?? '').split(',').map(id => id.trim()).filter(Boolean)
  const id = userId(c)
  const principal = authPrincipal(c)
  await ensureBuildPermission(c, appId, id)
  const ownerOrg = await getBuildOwnerOrg(c, principal, appId)
  return c.json({ outputs: await savedOutputsForJobs(c, principal, appId, ownerOrg, jobIds) })
})

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<SimulatorBody>(c)
  const id = userId(c)
  return startSimulator(c, body, id, authPrincipal(c))
})

app.get('/:id', middlewareAuth, async (c) => {
  const body = await parseBody<SimulatorBody>(c).catch(() => c.req.query() as SimulatorBody)
  const id = userId(c)
  return readSimulator(c, c.req.param('id'), body, id, authPrincipal(c))
})

app.post('/:id/stop', middlewareAuth, async (c) => {
  const body = await parseBody<SimulatorBody>(c)
  const id = userId(c)
  return stopSimulator(c, c.req.param('id'), body, id, authPrincipal(c))
})
