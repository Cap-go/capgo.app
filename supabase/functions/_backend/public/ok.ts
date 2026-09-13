import { resolveCapgoApiVersion } from '../utils/api_version.ts'
import { runCapgoWorkerLivenessProbe } from '../utils/capgo_health.ts'
import { BRES, honoFactory, parseBody, useCors } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'

export const app = honoFactory.createApp()

app.use('*', useCors)

app.post('/', async (c) => {
  await runCapgoWorkerLivenessProbe()
  const body = await parseBody<any>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'body', data: body })
  const apiVersion = resolveCapgoApiVersion(c)

  return apiVersion.handle({
    '2025-10-01': () => c.json(BRES),
    '2025-10-02': info => c.json({ ...BRES, version: info.normalized, detail: 'ok endpoint 2025-10-02 response' }),
    'default': () => c.json(BRES),
  })
})

app.get('/', async (c) => {
  await runCapgoWorkerLivenessProbe()
  const apiVersion = resolveCapgoApiVersion(c)

  return apiVersion.handle({
    '2025-10-01': () => c.json(BRES),
    '2025-10-02': info => c.json({ ...BRES, version: info.normalized, detail: 'ok endpoint 2025-10-02 response' }),
    'default': () => c.json(BRES),
  })
})
