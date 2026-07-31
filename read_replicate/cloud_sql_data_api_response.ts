export interface CloudSqlDataApiResponse {
  status?: {
    code?: number
    message?: string
  }
}

export function assertCloudSqlDataApiResponseSucceeded(
  response: CloudSqlDataApiResponse,
  errorFromMessage: (message: string) => Error,
): void {
  const status = response.status
  if (status?.code !== undefined && status.code !== 0) {
    throw errorFromMessage(
      status.message ?? `status code ${status.code}`,
    )
  }
}
