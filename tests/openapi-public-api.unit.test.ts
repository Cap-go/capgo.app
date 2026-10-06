import { describe, expect, it } from 'vitest'
import spec from '../docs/public-api/capgo-public-api-openapi.json'

describe('public API OpenAPI spec', () => {
  it('documents bundle list filters by version and id', () => {
    const getBundle = spec.paths['/bundle/']?.get
    expect(getBundle).toBeDefined()
    const names = (getBundle?.parameters ?? []).map((param: { name?: string, $ref?: string }) => param.name ?? param.$ref)
    expect(names).toContain('app_id')
    expect(names).toContain('version')
    expect(names).toContain('id')
  })
})
