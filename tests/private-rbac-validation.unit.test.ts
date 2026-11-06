import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  addGroupMemberBodyHook,
  addGroupMemberBodySchema,
  createGroupBodyHook,
  createGroupBodySchema,
  createRoleBindingBodyHook,
  createRoleBindingBodySchema,
  invalidOrgIdHook,
  orgIdParamSchema,
  updateGroupBodyHook,
  updateGroupBodySchema,
  updateRoleBindingBodyHook,
  updateRoleBindingBodySchema,
  validateJsonBody,
} from '../supabase/functions/_backend/private/rbac_validation.ts'

type ValidationIssues = readonly StandardSchemaV1.Issue[]

interface StandardSchema {
  '~standard': {
    validate: (value: unknown) => StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>
  }
}

async function getIssues(schema: StandardSchema, value: unknown): Promise<ValidationIssues> {
  const result = await Promise.resolve(schema['~standard'].validate(value))
  return result.issues ?? []
}

async function getErrorMessage(
  hook: (result: { success: false, error: ValidationIssues }, c: any) => Response | void,
  issues: ValidationIssues,
) {
  const response = hook(
    { success: false, error: issues },
    {
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    },
  )

  expect(response).toBeInstanceOf(Response)
  expect(response!.status).toBe(400)
  const payload = await response!.json() as { error: string }
  return payload.error
}

const ORG_ID = '550e8400-e29b-41d4-a716-446655440000'
const USER_ID = '550e8400-e29b-41d4-a716-446655440001'
const validChannelBinding = {
  principal_type: 'user',
  principal_id: USER_ID,
  role_name: 'org_admin',
  scope_type: 'channel',
  org_id: ORG_ID,
  app_id: '550e8400-e29b-41d4-a716-446655440002',
}

function createUpdateGroupApp() {
  const app = new Hono()
  app.put('/groups/:group_id', async (c) => {
    const result = await validateJsonBody(c, updateGroupBodySchema, updateGroupBodyHook)
    if (!result.ok)
      return result.response
    return c.json(result.data)
  })
  return app
}

describe('rBAC validation hooks', () => {
  it.concurrent.each([
    ['invalid org params', orgIdParamSchema, invalidOrgIdHook, { org_id: 'not-a-uuid' }, 'Invalid org_id'],
    ['create-group missing name', createGroupBodySchema, createGroupBodyHook, {}, 'Name is required'],
    ['create-group empty name', createGroupBodySchema, createGroupBodyHook, { name: '' }, 'Name is required'],
    ['update-group invalid description', updateGroupBodySchema, updateGroupBodyHook, { description: 42 }, 'Invalid description'],
    ['add-group-member invalid user', addGroupMemberBodySchema, addGroupMemberBodyHook, { user_id: 'bad-user-id' }, 'Invalid user_id'],
    ['role-binding missing required fields', createRoleBindingBodySchema, createRoleBindingBodyHook, {}, 'Missing required fields'],
    ['role-binding empty role name', createRoleBindingBodySchema, createRoleBindingBodyHook, { principal_type: 'user', principal_id: USER_ID, role_name: '', scope_type: 'org', org_id: ORG_ID }, 'Missing required fields'],
    ['role-binding invalid principal type', createRoleBindingBodySchema, createRoleBindingBodyHook, { principal_type: 'device', principal_id: USER_ID, role_name: 'org_admin', scope_type: 'org', org_id: ORG_ID }, 'Invalid principal_type'],
    ['role-binding update missing role name', updateRoleBindingBodySchema, updateRoleBindingBodyHook, {}, 'role_name is required'],
    ['role-binding update empty role name', updateRoleBindingBodySchema, updateRoleBindingBodyHook, { role_name: '' }, 'role_name is required'],
  ] as const)('keeps the legacy error for %s', async (_label, schema, hook, value, expected) => {
    const issues = await getIssues(schema, value)
    expect(await getErrorMessage(hook as Parameters<typeof getErrorMessage>[0], issues)).toBe(expected)
  })

  it.concurrent.each([
    ['UUID', '550e8400-e29b-41d4-a716-446655440003'],
    ['legacy numeric-string', '123'],
  ])('accepts %s channel ids for role bindings', async (_label, channelId) => {
    expect(await getIssues(createRoleBindingBodySchema, { ...validChannelBinding, channel_id: channelId })).toHaveLength(0)
  })

  it.concurrent('parses headerless JSON bodies for update validation', async () => {
    const response = await createUpdateGroupApp().request(new Request(`http://localhost/groups/${ORG_ID}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Renamed group' }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'Renamed group' })
  })

  it.concurrent.each([
    ['empty headerless body', {}],
    ['malformed JSON request', { headers: { 'Content-Type': 'application/json' }, body: '{"name":' }],
    ['malformed headerless body', { body: '{"name":' }],
  ] as const)('rejects %s with the legacy parse error', async (_label, init) => {
    const response = await createUpdateGroupApp().request(new Request(`http://localhost/groups/${ORG_ID}`, {
      method: 'PUT',
      ...init,
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'invalid_json_parse_body',
      message: 'Invalid JSON body',
    })
  })
})
