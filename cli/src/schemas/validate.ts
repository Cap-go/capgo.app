import { log } from '@clack/prompts'
import { safeParseSchema, type StandardSchema } from './schema_validation'

/**
 * Validate options using a Standard Schema with CLI-friendly error messages.
 * Preserves the existing silent/log.error pattern used across all commands.
 */
export function validateOptions<T>(schema: StandardSchema<T>, data: unknown, silent = false): T {
  const result = safeParseSchema(schema, data)
  if (result.success) {
    return result.data
  }

  const issues = result.error.issues
  const messages = issues.map((issue) => {
    const path = issue.path && issue.path.length > 0 ? issue.path.join('.') : ''
    return path ? `${path}: ${issue.message}` : issue.message
  })

  const errorMessage = `Validation failed:\n${messages.join('\n')}`

  if (!silent) {
    log.error(errorMessage)
  }

  throw new Error(errorMessage)
}
