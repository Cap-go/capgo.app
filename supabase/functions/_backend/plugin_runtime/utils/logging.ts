import { getRuntimeKey } from 'hono/adapter'

function formatLogArgs(message: unknown): unknown[] {
  if (message instanceof Error)
    return [serializeError(message)]
  if (typeof message === 'object' && message !== null) {
    const entries = Object.entries(message)
    return entries.flatMap(([key, value]) => [key, value])
  }
  return [message]
}

export function cloudlog(message: any) {
  if (getRuntimeKey() === 'workerd') {
    console.log(message)
    return
  }
  console.log(...formatLogArgs(message))
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
    return
  }
  console.error(...formatLogArgs(message))
}
