import type { BuildOutputRecord } from './output-record'
import { readFile } from 'node:fs/promises'
import { exit, stdout } from 'node:process'
import { log as clackLog } from '@clack/prompts'
import { trackEvent } from '../analytics/track'

export interface LastOutputOptions {
  path: string
  field?: string
  qr?: boolean
}

/** Allow-list of fields exposed via --field so typos surface as errors. */
const PRINTABLE_FIELDS = new Set([
  'schemaVersion',
  'jobId',
  'appId',
  'platform',
  'buildMode',
  'status',
  'outputUrl',
  'qrCodeAscii',
  'qrCodePngPath',
  'finishedAt',
])

export async function lastOutputCommand(options: LastOutputOptions): Promise<void> {
  if (!options.path) {
    clackLog.error('--path is required.')
    exit(1)
  }

  if (options.field !== undefined && options.qr) {
    clackLog.error('Pass either --field or --qr, not both.')
    exit(1)
  }

  const raw = await readFile(options.path, 'utf-8').catch((error: unknown) => {
    clackLog.error(`Could not read ${options.path}: ${stringifyError(error)}`)
    exit(1)
  })

  let record: BuildOutputRecord
  try {
    record = JSON.parse(raw) as BuildOutputRecord
  }
  catch (error) {
    clackLog.error(`${options.path} is not valid JSON: ${stringifyError(error)}`)
    exit(1)
  }

  if (record?.schemaVersion !== 1) {
    clackLog.error(`Unsupported record schemaVersion=${String(record?.schemaVersion)} (expected 1). Re-run the build with a matching CLI to refresh the file.`)
    exit(1)
  }

  void trackEvent({ channel: 'cli-usage', event: 'Build Last Output Viewed', tags: {} })

  if (options.qr) {
    stdout.write(`${record.qrCodeAscii ?? ''}\n`)
    return
  }

  if (options.field !== undefined) {
    if (!PRINTABLE_FIELDS.has(options.field)) {
      clackLog.error(`Unknown field "${options.field}". Available: ${[...PRINTABLE_FIELDS].sort().join(', ')}`)
      exit(1)
    }
    const value = (record as unknown as Record<string, unknown>)[options.field]
    stdout.write(`${value ?? ''}\n`)
    return
  }

  // Default: dump the JSON so callers can pipe to jq.
  stdout.write(`${JSON.stringify(record, null, 2)}\n`)
}

function stringifyError(error: unknown): string {
  if (error instanceof Error)
    return error.message
  return String(error)
}
