import { describe, expect, it } from 'vitest'
import { dataApiCommandError, GCLOUD_PARTIAL_RESULT_FLAG } from '../scripts/sync-read-replica-schema.ts'

describe('read-replica schema sync gcloud arguments', () => {
  it('passes the partial result mode with the hyphenated flag gcloud accepts', () => {
    expect(GCLOUD_PARTIAL_RESULT_FLAG).toBe('--partial-result-mode=FAIL_PARTIAL_RESULT')
  })

  it('reports a rejected argument as such, not as the 10 MB response limit', () => {
    const error = dataApiCommandError('ERROR: (gcloud.sql.instances.execute-sql) unrecognized arguments: --partial_result_mode=FAIL_PARTIAL_RESULT (did you mean \'--partial-result-mode\'?)')
    expect(error.message).toMatch(/^gcloud rejected the Cloud SQL Data API command arguments/)
    expect(error.message).not.toMatch(/10 MB/)
  })

  it('still reports the response size limit', () => {
    expect(dataApiCommandError('ERROR: response exceeds 10 MB limit').message).toMatch(/10 MB response limit/)
  })
})
