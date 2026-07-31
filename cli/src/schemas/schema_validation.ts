import type { StandardSchemaV1 } from '@standard-schema/spec'

export type ValidationIssue = StandardSchemaV1.Issue & { readonly code?: string }

export interface StandardSchema<T> {
  '~standard': {
    validate: (value: unknown) => StandardSchemaV1.Result<T> | Promise<StandardSchemaV1.Result<T>>
  }
}

export type SafeParseSchemaResult<T> = { success: true, data: T } | { success: false, error: SchemaError }

export class SchemaError extends Error {
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map(issue => issue.message).join('; ') || 'Schema validation failed')
    this.name = 'SchemaError'
    this.issues = issues
  }
}

function assertSyncResult<T>(
  result: StandardSchemaV1.Result<T> | Promise<StandardSchemaV1.Result<T>>,
): StandardSchemaV1.Result<T> {
  if (typeof (result as Promise<StandardSchemaV1.Result<T>> | undefined)?.then === 'function') {
    throw new TypeError('Expected synchronous schema validation result')
  }

  return result as StandardSchemaV1.Result<T>
}

export function safeParseSchema<T>(
  schema: StandardSchema<T>,
  value: unknown,
): SafeParseSchemaResult<T> {
  const result = assertSyncResult(schema['~standard'].validate(value))

  if (result.issues) {
    return {
      success: false,
      error: new SchemaError(result.issues as readonly ValidationIssue[]),
    }
  }

  return {
    success: true,
    data: result.value,
  }
}

export function parseSchema<T>(schema: StandardSchema<T>, value: unknown): T {
  const result = safeParseSchema(schema, value)

  if (!result.success) {
    throw result.error
  }

  return result.data
}
