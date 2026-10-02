/**
 * Non-2xx response from the Capgo HTTP API.
 * The upstream Response stays on `.context` so callers can read the JSON error payload.
 */
export class CapgoApiHttpError extends Error {
  readonly context: Response
  readonly status: number

  constructor(response: Response) {
    super(`Capgo API request failed with status ${response.status}`)
    this.name = 'CapgoApiHttpError'
    this.context = response
    this.status = response.status
  }
}
