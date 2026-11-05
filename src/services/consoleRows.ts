/** PostgREST returns at most this many rows per request (max_rows). */
const CONSOLE_PAGE_ROWS = 1000

/**
 * Read every row of an ordered query in max_rows pages. `page(from, to)` must
 * apply `.range(from, to)` to a query with a stable order.
 */
export async function readAllConsoleRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null, error: unknown }>): Promise<{ data: T[] | null, error: unknown }> {
  const rows: T[] = []
  for (let from = 0; ; from += CONSOLE_PAGE_ROWS) {
    const { data, error } = await page(from, from + CONSOLE_PAGE_ROWS - 1)
    if (error)
      return { data: null, error }
    rows.push(...(data ?? []))
    if (!data || data.length < CONSOLE_PAGE_ROWS)
      return { data: rows, error: null }
  }
}
