import { getRuntimeKey } from 'hono/adapter'
import { redactSensitiveUrl } from './sensitive_url.ts'

export function cloudlog(message: any) {
  if (getRuntimeKey() === 'workerd') {
    console.log(message)
  }
  else if (typeof message === 'object' && message !== null) {
    const entries = Object.entries(message)
    const logArgs = entries.flatMap(([key, value]) => [key, value])
    console.log(...logArgs)
  }
  else {
    console.log(message)
  }
}

export function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack, cause: err.cause ? String(err.cause) : undefined }
  }
  try {
    return { message: JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), stack: undefined, name: 'Error', cause: undefined }
  }
  catch {
    return { message: String(err), stack: undefined, name: 'Error', cause: undefined }
  }
}

export function cloudlogErr(message: any) {
  if (getRuntimeKey() === 'workerd') {
    console.error(message)
  }
  else if (typeof message === 'object' && message !== null) {
    const entries = Object.entries(message)
    const logArgs = entries.flatMap(([key, value]) => [key, value])
    console.error(...logArgs)
  }
  else {
    console.error(message)
  }
}

/** Printer for hono's access logger: same output as its default, with secret path tokens redacted. */
export function accessLog(message: string, ...rest: string[]) {
  console.log(redactSensitiveUrl(message), ...rest)
}
