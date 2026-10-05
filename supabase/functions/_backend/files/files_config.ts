import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { getRuntimeKey } from 'hono/adapter'
import { Hono } from 'hono/tiny'
import { useCors } from '../utils/hono.ts'
import { ALERT_UPLOAD_SIZE_BYTES, MAX_CHUNK_SIZE_BYTES, MAX_UPLOAD_LENGTH_BYTES } from './util.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.get('/', (c) => {
  if (getRuntimeKey() !== 'workerd') {
    // In Supabase Edge Functions runtime, TUS upload is supported via Supabase Storage proxy
    return c.json({
      partialUpload: false,
      partialUploadForced: false,
      maxUploadLength: MAX_UPLOAD_LENGTH_BYTES,
      maxChunkSize: MAX_CHUNK_SIZE_BYTES,
      alertUploadSize: ALERT_UPLOAD_SIZE_BYTES,
      TUSUpload: true,
      TUSUploadForced: false,
    })
  }
  // force partial and tus for 20% of the requests
  // const randomPU = Math.random()
  // const randomTUS = Math.random()
  // const forcePartialUpload = randomTUS < 0.5
  // const forceTUSUpload = randomTUS < 0.3
  // TODO: re add partial update when we use file extension for compression
  return c.json({
    partialUpload: true,
    partialUploadForced: false,
    maxUploadLength: MAX_UPLOAD_LENGTH_BYTES,
    maxChunkSize: MAX_CHUNK_SIZE_BYTES,
    alertUploadSize: ALERT_UPLOAD_SIZE_BYTES,
    TUSUpload: true,
    TUSUploadForced: true, // TODO: remove this when fix the issue with normal upload
  })
})
