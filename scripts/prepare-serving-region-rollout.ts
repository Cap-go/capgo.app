import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// Offline preparation only. Export this one nonsecret setting from private.settings
// on the intended environment. No provider/DB mutation or automatic activation.
const settings = z.array(z.object({ name: z.string(), value: z.string() }))
const epoch = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/)
const input = process.argv[2]
if (!input)
  throw new Error('Pass an explicit private.settings reader-epoch export path')
const values = settings.parse(JSON.parse(await readFile(resolve(input), 'utf8')))
if (values.length !== 1 || values[0].name !== 'CAPGO_SERVING_REGIONS_READER_EPOCH')
  throw new Error('Export only CAPGO_SERVING_REGIONS_READER_EPOCH; never export secrets')
const value = values[0].value === '' ? null : epoch.parse(values[0].value)
const target = fileURLToPath(new URL('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', import.meta.url))
await writeFile(target, `// Generated from private.settings CAPGO_SERVING_REGIONS_READER_EPOCH.\nexport const servingRegionReaderEpoch = ${JSON.stringify(value)}\n`)
