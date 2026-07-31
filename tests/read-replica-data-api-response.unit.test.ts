import { describe, expect, it } from 'vitest'
import { assertCloudSqlDataApiResponseSucceeded } from '../read_replicate/cloud_sql_data_api_response.ts'

function cloudSqlDataApiError(message: string) {
  return new Error(`Cloud SQL Data API query failed: ${message}`)
}

describe('read-replica Cloud SQL Data API response handling', () => {
  it.concurrent('rejects a failed SQL response even when gcloud exited successfully', () => {
    expect(() => assertCloudSqlDataApiResponseSucceeded({
      status: {
        code: 3,
        message: 'Execution failed. Details: pq: must be owner of table apps',
      },
    }, cloudSqlDataApiError)).toThrow(
      'Cloud SQL Data API query failed: Execution failed. Details: pq: must be owner of table apps',
    )
  })

  it.concurrent('accepts a successful SQL response', () => {
    expect(() => assertCloudSqlDataApiResponseSucceeded({
      status: { code: 0 },
    }, cloudSqlDataApiError)).not.toThrow()
  })
})
