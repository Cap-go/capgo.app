import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Context } from 'hono'
import { z } from 'zod'
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod'
import { simpleErrorWithStatus } from '../utils/hono.ts'
import { schema } from '../utils/postgres_schema.ts'

type ValidationIssue = StandardSchemaV1.Issue & { readonly code?: string }
type ValidationIssues = readonly ValidationIssue[]

// Use string + refine (not z.enum) so missing fields emit invalid_type and
// stay distinguishable from invalid values in error hooks.
const ROLE_SCOPE_TYPE_SCHEMA = z.string().min(1).refine(
  (value): value is 'org' | 'app' | 'channel' => value === 'org' || value === 'app' || value === 'channel',
)
const PRINCIPAL_TYPE_SCHEMA = z.string().min(1).refine(
  (value): value is 'user' | 'group' | 'apikey' => value === 'user' || value === 'group' || value === 'apikey',
)
const NON_EMPTY_STRING_SCHEMA = z.string().min(1)
const JSON_CONTENT_TYPE_REGEX = /^application\/(?:[a-z-.]+\+)?json(?:;\s*[a-zA-Z0-9-]+=[^;]+)*$/

interface StandardSchema<T> {
  '~standard': {
    validate: (value: unknown) => Promise<StandardSchemaV1.Result<T>> | StandardSchemaV1.Result<T>
  }
}

function firstIssueField(issues: ValidationIssues): string | undefined {
  const field = issues[0]?.path?.[0]
  if (typeof field === 'string') {
    return field
  }

  if (typeof field === 'object' && field !== null && 'key' in field && typeof field.key === 'string') {
    return field.key
  }

  return undefined
}

function issueField(issue: ValidationIssue): string | undefined {
  const field = issue.path?.[0]
  if (typeof field === 'string') {
    return field
  }

  if (typeof field === 'object' && field !== null && 'key' in field && typeof field.key === 'string') {
    return field.key
  }

  return undefined
}

function hasRequiredIssue(issues: ValidationIssues, field: string): boolean {
  return issues.some((issue) => {
    if (issueField(issue) !== field)
      return false
    const code = issue.code ?? ''
    // Zod: missing → invalid_type; ArkType-compat: required
    return code === 'required' || code === 'invalid_type'
  })
}

function hasRequiredValueIssue(issues: ValidationIssues, field: string): boolean {
  return issues.some((issue) => {
    if (issueField(issue) !== field)
      return false
    const code = issue.code ?? ''
    // Zod: missing → invalid_type, empty string → too_small
    return code === 'required' || code === 'invalid_type' || code === 'too_small' || code === 'minLength'
  })
}

function hasIssueForField(issues: ValidationIssues, field: string): boolean {
  return issues.some(issue => issueField(issue) === field)
}

function createErrorHook(resolveMessage: (issues: ValidationIssues) => string) {
  return (result: { success: true } | { success: false, error: ValidationIssues }, c: Context) => {
    if (result.success) {
      return
    }
    return c.json({ error: resolveMessage(result.error) }, 400)
  }
}

async function parseJsonBodyWithHeaderFallback(c: Context): Promise<{ ok: true, data: unknown } | { ok: false, response: Response }> {
  const contentType = c.req.header('Content-Type')

  if (contentType && JSON_CONTENT_TYPE_REGEX.test(contentType)) {
    try {
      return { ok: true, data: await c.req.json() }
    }
    catch {
      return { ok: false, response: simpleErrorWithStatus(c, 400, 'invalid_json_parse_body', 'Invalid JSON body') }
    }
  }

  const rawBody = await c.req.raw.clone().text()
  if (!rawBody) {
    return { ok: false, response: simpleErrorWithStatus(c, 400, 'invalid_json_parse_body', 'Invalid JSON body') }
  }

  try {
    return { ok: true, data: JSON.parse(rawBody) }
  }
  catch {
    return { ok: false, response: simpleErrorWithStatus(c, 400, 'invalid_json_parse_body', 'Invalid JSON body') }
  }
}

export async function validateJsonBody<T>(
  c: Context,
  schema: StandardSchema<T>,
  hook?: (result: { success: true } | { success: false, error: ValidationIssues }, c: Context) => Response | void | Promise<Response | void>,
): Promise<{ ok: true, data: T } | { ok: false, response: Response }> {
  const bodyResult = await parseJsonBodyWithHeaderFallback(c)
  if (!bodyResult.ok) {
    return bodyResult
  }

  const value = bodyResult.data
  const result = await Promise.resolve(schema['~standard'].validate(value))

  if (hook) {
    const hookResult = await hook(result.issues ? { success: false, error: result.issues as ValidationIssues } : { success: true }, c)
    if (hookResult) {
      return { ok: false, response: hookResult }
    }
  }

  if (result.issues) {
    return {
      ok: false,
      response: c.json({
        data: value,
        error: result.issues,
        success: false,
      }, 400),
    }
  }

  return { ok: true, data: result.value }
}

export const orgIdParamSchema = z.object({
  org_id: z.uuid(),
})

export const appIdParamSchema = z.object({
  app_id: z.uuid(),
})

export const groupIdParamSchema = z.object({
  group_id: z.uuid(),
})

export const groupMemberParamSchema = z.object({
  group_id: z.uuid(),
  user_id: z.uuid(),
})

export const bindingIdParamSchema = z.object({
  binding_id: z.uuid(),
})

export const roleScopeParamSchema = z.object({
  scope_type: ROLE_SCOPE_TYPE_SCHEMA,
})

export const createGroupBodySchema = createInsertSchema(schema.groups, {
  name: z.string().min(1),
}).pick({ name: true, description: true })

export const updateGroupBodySchema = createUpdateSchema(schema.groups).pick({ name: true, description: true })

export const addGroupMemberBodySchema = createInsertSchema(schema.group_members).pick({ user_id: true })

export const createRoleBindingBodySchema = z.object({
  principal_type: PRINCIPAL_TYPE_SCHEMA,
  principal_id: z.uuid(),
  scope_type: ROLE_SCOPE_TYPE_SCHEMA,
  org_id: z.uuid(),
  app_id: z.uuid().nullable().optional(),
  channel_id: z.union([z.uuid(), z.string().regex(/^\d+$/), z.number()]).nullable().optional(),
  reason: z.string().nullable().optional(),
  role_name: NON_EMPTY_STRING_SCHEMA,
})

export const updateRoleBindingBodySchema = z.object({
  role_name: NON_EMPTY_STRING_SCHEMA,
})

export const invalidOrgIdHook = createErrorHook(() => 'Invalid org_id')

export const invalidAppIdHook = createErrorHook(() => 'Invalid app_id')

export const invalidGroupIdHook = createErrorHook(() => 'Invalid group_id')

export const invalidBindingIdHook = createErrorHook(() => 'Invalid binding_id')

export const invalidScopeTypeHook = createErrorHook(() => 'Invalid scope_type')

export const invalidGroupMemberParamHook = createErrorHook((issues) => {
  return firstIssueField(issues) === 'user_id' ? 'Invalid user_id' : 'Invalid group_id'
})

export const createGroupBodyHook = createErrorHook((issues) => {
  if (hasRequiredValueIssue(issues, 'name')) {
    return 'Name is required'
  }

  switch (firstIssueField(issues)) {
    case 'name':
      return 'Invalid name'
    case 'description':
      return 'Invalid description'
    default:
      return 'Invalid request body'
  }
})

export const updateGroupBodyHook = createErrorHook((issues) => {
  switch (firstIssueField(issues)) {
    case 'name':
      return 'Invalid name'
    case 'description':
      return 'Invalid description'
    default:
      return 'Invalid request body'
  }
})

export const addGroupMemberBodyHook = createErrorHook((issues) => {
  if (hasRequiredIssue(issues, 'user_id')) {
    return 'user_id is required'
  }

  switch (firstIssueField(issues)) {
    case 'user_id':
      return 'Invalid user_id'
    default:
      return 'Invalid request body'
  }
})

export const createRoleBindingBodyHook = createErrorHook((issues) => {
  if (
    ['principal_type', 'principal_id', 'scope_type', 'org_id'].some(field => hasRequiredIssue(issues, field))
    || hasRequiredValueIssue(issues, 'role_name')
  ) {
    return 'Missing required fields'
  }

  for (const [field, message] of [
    ['principal_type', 'Invalid principal_type'],
    ['principal_id', 'Invalid principal_id'],
    ['role_name', 'Invalid role_name'],
    ['scope_type', 'Invalid scope_type'],
    ['org_id', 'Invalid org_id'],
    ['app_id', 'Invalid app_id'],
    ['channel_id', 'Invalid channel_id'],
    ['reason', 'Invalid reason'],
  ] as const) {
    if (hasIssueForField(issues, field)) {
      return message
    }
  }

  return 'Invalid request body'
})

export const updateRoleBindingBodyHook = createErrorHook((issues) => {
  if (hasRequiredValueIssue(issues, 'role_name')) {
    return 'role_name is required'
  }

  switch (firstIssueField(issues)) {
    case 'role_name':
      return 'Invalid role_name'
    default:
      return 'Invalid request body'
  }
})
