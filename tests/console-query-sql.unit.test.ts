import type { QueryCatalog, QueryColumn, QueryForeignKey, QueryFunction } from '../supabase/functions/_backend/private/console_query_sql'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { drizzleFrom, finishConsoleQuery, readSqlError, statusForSqlState } from '../supabase/functions/_backend/private/console_query_run'
import { compileConsoleQuery, functionFromCatalogRow, shapeConsoleQueryResult } from '../supabase/functions/_backend/private/console_query_sql'

function column(name: string, udt: string): QueryColumn {
  return { name, udt }
}

function key(name: string, sourceTable: string, sourceColumn: string, targetTable: string, targetColumn: string, unique = false): QueryForeignKey {
  return { name, sourceTable, sourceColumn, targetTable, targetColumn, unique }
}

function fn(name: string, argNames: string[], argTypes: string[], returnsSet = false, returnsComposite = false, defaultCount = 0): QueryFunction {
  return { name, argNames, argTypes, returnsSet, returnsComposite, defaultCount }
}

const catalog: QueryCatalog = {
  columns: new Map([
    ['users', [column('id', 'uuid'), column('email', 'text'), column('onboarding', 'jsonb')]],
    ['orgs', [column('id', 'uuid'), column('name', 'text'), column('customer_id', 'text'), column('created_at', 'timestamptz')]],
    ['stripe_info', [column('customer_id', 'text'), column('paid_at', 'timestamptz'), column('trial_at', 'timestamptz')]],
    ['org_users', [column('user_id', 'uuid'), column('org_id', 'uuid')]],
    ['deploy_history', [column('id', 'int8'), column('app_id', 'text'), column('channel_id', 'int8'), column('version_id', 'int8'), column('created_at', 'timestamptz')]],
    ['app_versions', [column('id', 'int8'), column('name', 'text'), column('app_id', 'text'), column('created_at', 'timestamptz'), column('deleted', 'bool'), column('native_packages', 'jsonb')]],
    ['channels', [column('id', 'int8'), column('name', 'text'), column('app_id', 'text'), column('version', 'int8')]],
    ['audit_logs', [column('org_id', 'uuid'), column('operation', 'text'), column('table_name', 'text'), column('changed_fields', '_text'), column('old_record', 'jsonb'), column('created_at', 'timestamptz'), column('record_id', 'text')]],
    ['role_bindings', [column('principal_id', 'text'), column('role_id', 'uuid'), column('org_id', 'uuid')]],
    ['roles', [column('id', 'uuid'), column('name', 'text')]],
    ['apps', [column('id', 'uuid'), column('app_id', 'text'), column('owner_org', 'uuid'), column('created_by', 'uuid'), column('other_user', 'uuid')]],
    ['group_members', [column('group_id', 'uuid'), column('user_id', 'uuid')]],
  ]),
  foreignKeys: [
    key('orgs_customer_id_fkey', 'orgs', 'customer_id', 'stripe_info', 'customer_id'),
    key('org_users_user_id_fkey', 'org_users', 'user_id', 'users', 'id'),
    key('deploy_history_version_id_fkey', 'deploy_history', 'version_id', 'app_versions', 'id'),
    key('deploy_history_channel_id_fkey', 'deploy_history', 'channel_id', 'channels', 'id'),
    key('channels_version_fkey', 'channels', 'version', 'app_versions', 'id'),
    key('role_bindings_role_id_fkey', 'role_bindings', 'role_id', 'roles', 'id'),
    key('apps_owner_org_fkey', 'apps', 'owner_org', 'orgs', 'id'),
    key('apps_created_by_fkey', 'apps', 'created_by', 'users', 'id'),
    key('apps_other_user_fkey', 'apps', 'other_user', 'users', 'id'),
  ],
  functions: [
    fn('is_platform_admin', [], []),
    fn('is_platform_admin', ['userid'], ['uuid']),
    fn('is_not_deleted', ['email_check'], ['varchar']),
    fn('get_org_members', ['guild_id'], ['uuid'], true, true),
    fn('get_org_members', ['guild_id', 'user_id'], ['uuid', 'uuid'], true, true),
  ],
}

function flat(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function compile(request: Parameters<typeof compileConsoleQuery>[1]) {
  const compiled = compileConsoleQuery(catalog, request)
  return { ...compiled, text: flat(compiled.text) }
}

describe('console query sql', () => {
  it('keeps an apostrophe literal in an or filter', () => {
    const compiled = compile({
      kind: 'table',
      name: 'channels',
      args: [],
      operations: [
        { method: 'select', args: ['id, name'] },
        { method: 'or', args: ['name.ilike.%O\'Reilly%,id.in.(42)'] },
      ],
    })
    expect(compiled.text).toContain('t."name" ILIKE $1')
    expect(compiled.text).toContain('OR t."id" = ANY($2::bigint[])')
    expect(compiled.values).toEqual(['%O\'Reilly%', ['42']])
  })

  it('compiles an equality filter and keeps the value out of the SQL text', () => {
    const compiled = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['id, email'] }, { method: 'eq', args: ['id', 'user-1'] }, { method: 'single', args: [] }],
    })
    expect(compiled.text).toBe('SELECT jsonb_build_object(\'id\', t."id", \'email\', t."email") AS row FROM "public"."users" AS t WHERE t."id" = $1::uuid LIMIT 2')
    expect(compiled.values).toEqual(['user-1'])
    expect(compiled.text).not.toContain('user-1')
    expect(compiled.cardinality).toBe('one')
  })

  it('treats eq and neq null as null checks', () => {
    const missing = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['*'] }, { method: 'eq', args: ['email', null] }],
    })
    expect(missing.text).toContain('WHERE t."email" IS NULL')
    const present = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'not', args: ['email', 'is', null] }],
    })
    expect(present.text).toContain('WHERE NOT (t."email" IS NULL)')
  })

  it('compiles in, jsonb equality, and a json path as text', () => {
    const listed = compile({
      kind: 'table',
      name: 'role_bindings',
      args: [],
      operations: [{ method: 'select', args: ['principal_id'] }, { method: 'in', args: ['principal_id', ['a', 'b']] }],
    })
    expect(listed.text).toContain('t."principal_id" = ANY($1::text[])')
    expect(listed.values).toEqual([['a', 'b']])
    const dialect = new PgDialect()
    const bound = dialect.sqlToQuery(drizzleFrom(listed.text, listed.values))
    expect(bound.sql).toContain('= ANY($1::text[])')
    expect(bound.params).toEqual([['a', 'b']])

    const orgs = compile({
      kind: 'table',
      name: 'apps',
      args: [],
      operations: [{ method: 'select', args: ['app_id'] }, { method: 'in', args: ['owner_org', ['11111111-1111-4111-8111-111111111111']] }],
    })
    const oneOrg = dialect.sqlToQuery(drizzleFrom(orgs.text, orgs.values))
    expect(oneOrg.sql).toContain('= ANY($1::uuid[])')
    expect(oneOrg.params).toEqual([['11111111-1111-4111-8111-111111111111']])

    const onboarding = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'filter', args: ['onboarding', 'eq', '{"step":1}'] }],
    })
    expect(onboarding.text).toContain('t."onboarding" = $1::jsonb')
    expect(onboarding.values).toEqual(['{"step":1}'])

    const path = compile({
      kind: 'table',
      name: 'audit_logs',
      args: [],
      operations: [{ method: 'eq', args: ['old_record->>version', '1.2.3'] }],
    })
    expect(path.text).toContain('(t."old_record"->>\'version\') = $1::text')
    expect(path.values).toEqual(['1.2.3'])
  })

  it('compiles or, and, and not.cd array literals', () => {
    const compiled = compile({
      kind: 'table',
      name: 'audit_logs',
      args: [],
      operations: [{ method: 'or', args: ['operation.eq.INSERT,and(operation.eq.UPDATE,changed_fields.not.cd.{updated_at})'] }],
    })
    expect(compiled.text).toContain('WHERE (t."operation" = $1::text OR (t."operation" = $2::text AND NOT (t."changed_fields" <@ $3::text[])))')
    expect(compiled.values).toEqual(['INSERT', 'UPDATE', '{updated_at}'])
  })

  it('embeds a foreign key column, an inner target table, and stripe_info', () => {
    const history = compile({
      kind: 'table',
      name: 'deploy_history',
      args: [],
      operations: [
        { method: 'select', args: ['*, version:version_id (id, name)'] },
        { method: 'eq', args: ['app_id', 'com.demo.app'] },
        { method: 'like', args: ['version.name', '%demo%'] },
        { method: 'order', args: ['created_at', { ascending: false, nullsFirst: true }] },
        { method: 'range', args: [10, 19] },
      ],
    })
    expect(history.text).toContain('to_jsonb(t) || jsonb_build_object(\'version\', (SELECT jsonb_build_object(\'id\', e1."id", \'name\', e1."name") FROM "public"."app_versions" AS e1 WHERE e1."id" = t."version_id"))')
    expect(history.text).toContain('EXISTS (SELECT 1 FROM "public"."app_versions" AS ef WHERE ef."id" = t."version_id" AND ef."name" LIKE $2::text)')
    expect(history.text).toContain('ORDER BY t."created_at" DESC NULLS FIRST LIMIT 10 OFFSET 10')
    expect(history.values).toEqual(['com.demo.app', '%demo%'])

    const members = compile({
      kind: 'table',
      name: 'org_users',
      args: [],
      operations: [{ method: 'select', args: ['user_id, users!inner(email)'] }, { method: 'eq', args: ['org_id', 'org-1'] }],
    })
    expect(members.text).toContain('\'users\', (SELECT jsonb_build_object(\'email\', e1."email") FROM "public"."users" AS e1 WHERE e1."id" = t."user_id")')
    expect(members.text).toContain('EXISTS (SELECT 1 FROM "public"."users" AS ei WHERE ei."id" = t."user_id")')

    const billing = compile({
      kind: 'table',
      name: 'orgs',
      args: [],
      operations: [{ method: 'select', args: ['created_at, stripe_info(paid_at, trial_at)'] }, { method: 'maybeSingle', args: [] }],
    })
    expect(billing.text).toContain('\'stripe_info\', (SELECT jsonb_build_object(\'paid_at\', e1."paid_at", \'trial_at\', e1."trial_at") FROM "public"."stripe_info" AS e1 WHERE e1."customer_id" = t."customer_id")')
    expect(billing.cardinality).toBe('maybe')

    const channel = compile({
      kind: 'table',
      name: 'channels',
      args: [],
      operations: [{ method: 'select', args: ['version:app_versions!channels_version_fkey(native_packages)'] }],
    })
    expect(channel.text).toContain('FROM "public"."app_versions" AS e1 WHERE e1."id" = t."version"')
  })

  it('keeps an exact count when the page is empty and caps the page size', () => {
    const compiled = compile({
      kind: 'table',
      name: 'audit_logs',
      args: [],
      operations: [{ method: 'select', args: ['*', { count: 'estimated', head: false }] }, { method: 'limit', args: [5000] }],
    })
    expect(compiled.count).toBe(true)
    expect(compiled.text).toContain('SELECT count(*)::bigint AS total_count FROM "public"."audit_logs" AS t')
    expect(compiled.text).toContain('LEFT JOIN LATERAL')
    expect(compiled.text).toContain('LIMIT 1000')
    expect(compiled.text).not.toContain('LIMIT 5000')

    const head = compile({
      kind: 'table',
      name: 'apps',
      args: [],
      operations: [{ method: 'select', args: ['id', { count: 'exact', head: true }] }],
    })
    expect(head.head).toBe(true)
    expect(head.text).toBe('SELECT count(*)::bigint AS total_count FROM "public"."apps" AS t')
  })

  it('compiles upsert, ignore-duplicates, and a filtered jsonb update', () => {
    const upsert = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'upsert', args: [{ id: 'user-1', email: 'person@example.com' }, { onConflict: 'id' }] }, { method: 'select', args: [] }, { method: 'single', args: [] }],
    })
    expect(upsert.text).toContain('INSERT INTO "public"."users" ("id", "email") VALUES ($1::uuid, $2::text) ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email" RETURNING *')
    expect(upsert.values).toEqual(['user-1', 'person@example.com'])

    const ignored = compile({
      kind: 'table',
      name: 'group_members',
      args: [],
      operations: [{ method: 'upsert', args: [[{ group_id: 'g', user_id: 'u' }], { onConflict: 'group_id,user_id', ignoreDuplicates: true }] }],
    })
    expect(ignored.text).toContain('ON CONFLICT ("group_id", "user_id") DO NOTHING')
    expect(ignored.text).not.toContain('RETURNING')
    expect(ignored.minimal).toBe(true)
    expect(shapeConsoleQueryResult(ignored, [{ row: { group_id: 'g' } }])).toEqual({ data: null, error: null, count: null, status: 200 })

    const update = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'update', args: [{ onboarding: { step: 1 } }] }, { method: 'eq', args: ['id', 'user-1'] }, { method: 'filter', args: ['onboarding', 'eq', '{"step":1}'] }],
    })
    expect(update.text).toContain('SET "onboarding" = $3::jsonb')
    expect(update.text).toContain('t."id" = $1::uuid')
    expect(update.text).toContain('t."onboarding" = $2::jsonb')
    expect(update.text).not.toContain('RETURNING')
    expect(update.values).toEqual(['user-1', '{"step":1}', '{"step":1}'])
  })

  it('rejects identifiers and ambiguous relationships', () => {
    expect(() => compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'eq', args: ['id;drop', 'x'] }],
    })).toThrow(/Invalid identifier/)
    expect(() => compile({
      kind: 'table',
      name: 'apps',
      args: [],
      operations: [{ method: 'select', args: ['users(id)'] }],
    })).toThrow(/more than one relationship/)
    expect(() => compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'order', args: ['missing'] }],
    })).toThrow(/does not exist/)
  })

  it('picks the RPC overload from the provided argument names', () => {
    const admin = compile({ kind: 'rpc', name: 'is_platform_admin', args: [], operations: [] })
    expect(admin.text).toBe('SELECT to_jsonb(public."is_platform_admin"()) AS data')
    const probe = compile({ kind: 'rpc', name: 'is_not_deleted', args: [{ email_check: 'nobody@example.com' }], operations: [] })
    expect(probe.text).toBe('SELECT to_jsonb(public."is_not_deleted"("email_check" => $1::varchar)) AS data')
    expect(probe.values).toEqual(['nobody@example.com'])
    const members = compile({ kind: 'rpc', name: 'get_org_members', args: [{ guild_id: 'org-1' }], operations: [] })
    expect(members.text).toContain('jsonb_agg(to_jsonb(q)) FROM (SELECT * FROM public."get_org_members"("guild_id" => $1::uuid) AS q LIMIT 1000) AS q')
    expect(members.returnsSet).toBe(true)
  })

  it('shapes pages, cardinality, and scalar RPC results', () => {
    const many = compile({ kind: 'table', name: 'users', args: [], operations: [{ method: 'select', args: ['id'] }] })
    expect(shapeConsoleQueryResult(many, [{ row: { id: 'a' } }, { row: { id: 'b' } }]).data).toEqual([{ id: 'a' }, { id: 'b' }])

    const single = compile({ kind: 'table', name: 'users', args: [], operations: [{ method: 'single', args: [] }] })
    expect(shapeConsoleQueryResult(single, []).error?.code).toBe('PGRST116')
    expect(shapeConsoleQueryResult(single, []).status).toBe(406)
    expect(shapeConsoleQueryResult(single, [{ row: { id: 'a' } }, { row: { id: 'b' } }]).error?.code).toBe('PGRST116')

    const maybe = compile({ kind: 'table', name: 'users', args: [], operations: [{ method: 'maybeSingle', args: [] }] })
    expect(shapeConsoleQueryResult(maybe, []).data).toBeNull()
    expect(shapeConsoleQueryResult(maybe, []).error).toBeNull()

    const counted = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['id', { count: 'exact' }] }],
    })
    const page = shapeConsoleQueryResult(counted, [{ row: null, total_count: '4' }])
    expect(page.data).toEqual([])
    expect(page.count).toBe(4)

    const head = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['id', { count: 'exact', head: true }] }],
    })
    expect(shapeConsoleQueryResult(head, [{ total_count: '8' }])).toEqual({ data: null, error: null, count: 8, status: 200 })

    const rpc = compile({ kind: 'rpc', name: 'is_platform_admin', args: [], operations: [] })
    expect(shapeConsoleQueryResult(rpc, [{ data: false }]).data).toBe(false)
    expect(shapeConsoleQueryResult(rpc, [{ data: '{"step":1}' }]).data).toBe('{"step":1}')
    expect(shapeConsoleQueryResult(rpc, [{ data: { step: 1 } }]).data).toEqual({ step: 1 })
  })

  it('reads function signatures from the array text node-pg leaves unparsed', () => {
    const zero = functionFromCatalogRow({
      name: 'is_platform_admin',
      returns_set: false,
      arg_count: 0,
      arg_names: null,
      arg_modes: null,
      return_kind: 'b',
      arg_types: '{}',
    })
    const named = functionFromCatalogRow({
      name: 'is_not_deleted',
      returns_set: false,
      arg_count: 1,
      arg_names: ['email_check'],
      arg_modes: '{i}',
      return_kind: 'b',
      arg_types: '{varchar}',
    })
    const withOut = functionFromCatalogRow({
      name: 'example',
      returns_set: false,
      arg_count: 1,
      arg_names: '{email_check,result}',
      arg_modes: '{i,o}',
      return_kind: 'b',
      arg_types: '{varchar}',
    })
    expect(zero?.argNames).toEqual([])
    expect(named?.argNames).toEqual(['email_check'])
    expect(named?.argTypes).toEqual(['varchar'])
    expect(withOut?.argNames).toEqual(['email_check'])

    const parsed: QueryCatalog = {
      columns: new Map(),
      foreignKeys: [],
      functions: [zero, named].filter(item => item != null),
    }
    expect(compileConsoleQuery(parsed, { kind: 'rpc', name: 'is_platform_admin', args: [], operations: [] }).text).toContain('public."is_platform_admin"()')
    const deleted = compileConsoleQuery(parsed, { kind: 'rpc', name: 'is_not_deleted', args: [{ email_check: 'nobody@example.com' }], operations: [] })
    expect(deleted.text).toContain('public."is_not_deleted"("email_check" => $1::varchar)')
    expect(deleted.values).toEqual(['nobody@example.com'])
  })

  it('returns every column of a table function and omits defaulted arguments', () => {
    const orgs = functionFromCatalogRow({
      name: 'get_orgs_v7',
      returns_set: true,
      arg_count: 0,
      arg_names: '{gid,name}',
      arg_modes: '{t,t}',
      return_kind: 'p',
      arg_types: '{}',
      default_count: 0,
    })
    const orgsForUser = functionFromCatalogRow({
      name: 'get_orgs_v7',
      returns_set: true,
      arg_count: 1,
      arg_names: '{userid,gid,name}',
      arg_modes: '{i,t,t}',
      return_kind: 'p',
      arg_types: '{uuid}',
      default_count: 0,
    })
    const scalarSet = functionFromCatalogRow({
      name: 'list_ids',
      returns_set: true,
      arg_count: 0,
      arg_names: null,
      arg_modes: null,
      return_kind: 'b',
      arg_types: '{}',
    })
    const permission = functionFromCatalogRow({
      name: 'rbac_check_permission',
      returns_set: false,
      arg_count: 4,
      arg_names: '{p_permission_key,p_org_id,p_app_id,p_channel_id}',
      arg_modes: null,
      return_kind: 'b',
      arg_types: '{text,uuid,varchar,int8}',
      default_count: '3',
    })
    expect(orgs?.argNames).toEqual([])
    expect(orgs?.returnsComposite).toBe(true)
    expect(orgsForUser?.argNames).toEqual(['userid'])
    expect(scalarSet?.returnsComposite).toBe(false)
    expect(permission?.defaultCount).toBe(3)

    const parsed: QueryCatalog = {
      columns: new Map(),
      foreignKeys: [],
      functions: [orgs, orgsForUser, scalarSet, permission].filter(item => item != null),
    }
    const listed = compileConsoleQuery(parsed, { kind: 'rpc', name: 'get_orgs_v7', args: [], operations: [] })
    expect(listed.text).toContain('jsonb_agg(to_jsonb(q)) FROM (SELECT * FROM public."get_orgs_v7"() AS q LIMIT 1000) AS q')
    expect(listed.text).not.toContain('q(val)')
    const ids = compileConsoleQuery(parsed, { kind: 'rpc', name: 'list_ids', args: [], operations: [] })
    expect(ids.text).toContain('jsonb_agg(to_jsonb(q.val)) FROM (SELECT val FROM public."list_ids"() AS q(val) LIMIT 1000) AS q')

    const check = compileConsoleQuery(parsed, {
      kind: 'rpc',
      name: 'rbac_check_permission',
      args: [{ p_permission_key: 'org.read_billing', p_org_id: 'org-1' }],
      operations: [],
    })
    expect(check.text).toContain('public."rbac_check_permission"("p_permission_key" => $1::text, "p_org_id" => $2::uuid)')
    expect(check.text).not.toContain('p_app_id')
    expect(check.text).not.toContain('p_channel_id')
    expect(check.values).toEqual(['org.read_billing', 'org-1'])
    expect(() => compileConsoleQuery(parsed, {
      kind: 'rpc',
      name: 'rbac_check_permission',
      args: [{ p_org_id: 'org-1' }],
      operations: [],
    })).toThrow(/Could not find the function/)
    expect(() => compileConsoleQuery({
      columns: new Map(),
      foreignKeys: [],
      functions: [
        fn('ambiguous', ['a'], ['text']),
        fn('ambiguous', ['a', 'b'], ['text', 'text'], false, false, 1),
      ],
    }, { kind: 'rpc', name: 'ambiguous', args: [{ a: 'x' }], operations: [] })).toThrow(/Could not find the function/)
  })

  it('preserves RPC argument types and pages set-returning functions', () => {
    const apps = fn(
      'get_org_apps_with_last_upload',
      ['p_org_id', 'p_search', 'p_sort_by', 'p_sort_desc', 'p_limit', 'p_offset'],
      ['uuid', 'text', 'text', 'bool', 'int4', 'int4'],
      true,
      true,
      5,
    )
    const uploads = fn(
      'get_bundle_upload_daily_counts',
      ['p_app_ids', 'p_start', 'p_end'],
      ['_varchar', 'timestamptz', 'timestamptz'],
      true,
      true,
    )
    const parsed: QueryCatalog = {
      columns: new Map(),
      foreignKeys: [],
      functions: [apps, uploads],
    }
    const listed = compileConsoleQuery(parsed, {
      kind: 'rpc',
      name: 'get_org_apps_with_last_upload',
      args: [{ p_org_id: 'org-1', p_limit: 10, p_offset: 20 }],
      operations: [],
    })
    expect(listed.text).toContain('"p_limit" => $2::integer')
    expect(listed.text).toContain('"p_offset" => $3::integer')
    expect(listed.text).not.toContain('bigint')
    expect(listed.values).toEqual(['org-1', 10, 20])

    const page = compileConsoleQuery(parsed, {
      kind: 'rpc',
      name: 'get_bundle_upload_daily_counts',
      args: [{ p_app_ids: ['com.demo.app'], p_start: '2026-01-01T00:00:00.000Z', p_end: '2026-01-02T00:00:00.000Z' }],
      operations: [{ method: 'range', args: [0, 999] }],
    })
    expect(flat(page.text)).toContain('jsonb_agg(to_jsonb(q)) FROM (SELECT * FROM public."get_bundle_upload_daily_counts"("p_app_ids" => $1::varchar[], "p_start" => $2::timestamptz, "p_end" => $3::timestamptz) AS q LIMIT 1000) AS q')
    expect(page.text).not.toContain('text[]')
    expect(page.text).not.toContain('OFFSET')
    expect(page.values).toEqual([['com.demo.app'], '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'])

    const next = compileConsoleQuery(parsed, {
      kind: 'rpc',
      name: 'get_bundle_upload_daily_counts',
      args: [{ p_app_ids: ['com.demo.app'], p_start: '2026-01-01T00:00:00.000Z', p_end: '2026-01-02T00:00:00.000Z' }],
      operations: [{ method: 'range', args: [1000, 2999] }],
    })
    expect(next.text).toContain('LIMIT 1000 OFFSET 1000')

    const channel = compile({
      kind: 'table',
      name: 'channels',
      args: [],
      operations: [{ method: 'eq', args: ['id', 1] }],
    })
    expect(channel.text).toContain('t."id" = $1::bigint')
  })

  it('keeps a json string on writes and parses filter in lists', () => {
    const update = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'update', args: [{ onboarding: '1.0' }] }, { method: 'eq', args: ['id', 'user-1'] }, { method: 'select', args: [] }],
    })
    expect(update.text).toContain('RETURNING')
    expect(update.values).toEqual(['user-1', '"1.0"'])

    const filter = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'filter', args: ['onboarding', 'eq', '1.0'] }],
    })
    expect(filter.values).toEqual(['1.0'])

    const listed = compile({
      kind: 'table',
      name: 'channels',
      args: [],
      operations: [{ method: 'filter', args: ['id', 'in', '(5,6,7)'] }],
    })
    expect(listed.text).toContain('t."id" = ANY($1::bigint[])')
    expect(listed.values).toEqual([['5', '6', '7']])

    const excluded = compile({
      kind: 'table',
      name: 'channels',
      args: [],
      operations: [{ method: 'not', args: ['id', 'in', '(5,6)'] }],
    })
    expect(excluded.text).toContain('NOT (t."id" = ANY($1::bigint[]))')
    expect(excluded.values).toEqual([['5', '6']])

    const noted = compileConsoleQuery({
      ...catalog,
      functions: [...catalog.functions, fn('save_note', ['payload'], ['jsonb'])],
    }, {
      kind: 'rpc',
      name: 'save_note',
      args: [{ payload: '1.0' }],
      operations: [],
    })
    expect(noted.values).toEqual(['"1.0"'])

    const counted = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'delete', args: [undefined, { count: 'exact', head: true }] }, { method: 'eq', args: ['id', 'user-1'] }],
    })
    expect(counted.text).toContain('DELETE FROM "public"."users" AS t WHERE t."id" = $1::uuid RETURNING *')
    expect(counted.head).toBe(true)

    const ordered = compile({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [
        { method: 'update', args: [{ email: 'person@example.com' }] },
        { method: 'eq', args: ['id', 'user-1'] },
        { method: 'select', args: [] },
        { method: 'order', args: ['email', { ascending: true }] },
      ],
    })
    expect(ordered.text).toContain('ORDER BY w."email" ASC')
    expect(ordered.text).not.toContain('ORDER BY t.')
  })

  it('does not treat a quoted placeholder as a bind', () => {
    const dialect = new PgDialect()
    const quoted = dialect.sqlToQuery(drizzleFrom('select \'$1\', "$1", $1::uuid', ['real-id']))
    expect(quoted.sql).toContain('\'$1\'')
    expect(quoted.sql).toContain('"$1"')
    expect(quoted.params).toEqual(['real-id'])

    const repeated = dialect.sqlToQuery(drizzleFrom('select $1::text, $1::text', ['a']))
    expect(repeated.params).toEqual(['a', 'a'])

    const dollar = dialect.sqlToQuery(drizzleFrom('select $body$ $1 $body$, $1::text', ['kept']))
    expect(dollar.sql).toContain('$body$ $1 $body$')
    expect(dollar.params).toEqual(['kept'])
  })

  it('maps permission failures by session and rethrows connection failures', () => {
    expect(statusForSqlState('42501', 'authenticated')).toBe(403)
    expect(statusForSqlState('42501', 'anon')).toBe(401)
    expect(statusForSqlState('23505', 'authenticated')).toBe(409)
    expect(statusForSqlState('42P01', 'authenticated')).toBe(400)

    const denied = new Error('Failed query: update users params: person@example.com')
    Object.assign(denied, {
      cause: Object.assign(new Error('permission denied for table users'), {
        name: 'DatabaseError',
        code: '42501',
        severity: 'ERROR',
      }),
    })
    expect(readSqlError(denied)).toEqual({ code: '42501', message: 'permission denied for table users' })

    expect(readSqlError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBeNull()
    for (const code of ['08006', '53300', '57P01']) {
      expect(readSqlError(Object.assign(new Error('connection failed'), { name: 'DatabaseError', code, severity: 'FATAL' }))).toBeNull()
    }
    expect(readSqlError(Object.assign(new Error('canceling statement due to statement timeout'), { name: 'DatabaseError', code: '57014', severity: 'ERROR' }))).toEqual({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })
  })

  it('throws a rollback signal when singular cardinality fails', () => {
    const ok = { data: [{ id: 'a' }], error: null, count: null, status: 200 }
    expect(finishConsoleQuery(ok)).toBe(ok)

    const failed = {
      data: null,
      error: {
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: 'The result contains 2 rows',
      },
      count: null,
      status: 406,
    }
    expect(() => finishConsoleQuery(failed)).toThrowError(expect.objectContaining({
      name: 'ConsoleQueryRollback',
      result: failed,
    }))
  })
})
