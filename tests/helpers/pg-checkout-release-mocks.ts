/** Test doubles for checkoutPgClient/releasePgClient (non-Hyperdrive Pool path). */
export async function checkoutPgClient(pg: { connect: () => Promise<unknown> }) {
  return await pg.connect()
}

export function releasePgClient(
  _pg: unknown,
  client: { release?: (error?: boolean | Error) => void } | null | undefined,
  error?: boolean | Error,
): void {
  if (client && 'release' in client)
    client.release?.(error)
}
