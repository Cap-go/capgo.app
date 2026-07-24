import { sValidator } from '@hono/standard-validator'
import { and, eq } from 'drizzle-orm'
import { createHono, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { schema } from '../utils/postgres_schema.ts'
import { version } from '../utils/version.ts'
import { invalidScopeTypeHook, roleScopeParamSchema } from './rbac_validation.ts'

export const app = createHono('', version)

app.use('*', useCors)
app.use('*', middlewareAuth)

// GET /private/roles - Liste des rôles assignables
app.get('/', async (c) => {
  const userId = c.get('auth')?.userId

  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    // Récupérer tous les rôles assignables
    const roles = await drizzle
      .select({
        id: schema.roles.id,
        name: schema.roles.name,
        scope_type: schema.roles.scope_type,
        description: schema.roles.description,
        priority_rank: schema.roles.priority_rank,
        is_assignable: schema.roles.is_assignable,
      })
      .from(schema.roles)
      .where(eq(schema.roles.is_assignable, true))
      .orderBy(schema.roles.priority_rank)

    return c.json(roles)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'roles_fetch_failed',
      userId,
      error,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /private/roles/:scope_type - Liste des rôles par scope
app.get('/:scope_type', sValidator('param', roleScopeParamSchema, invalidScopeTypeHook), async (c) => {
  const { scope_type: scopeType } = c.req.valid('param')
  const userId = c.get('auth')?.userId

  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    // Récupérer les rôles pour ce scope
    const roles = await drizzle
      .select({
        id: schema.roles.id,
        name: schema.roles.name,
        scope_type: schema.roles.scope_type,
        description: schema.roles.description,
        priority_rank: schema.roles.priority_rank,
        is_assignable: schema.roles.is_assignable,
      })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.scope_type, scopeType),
          eq(schema.roles.is_assignable, true),
        ),
      )
      .orderBy(schema.roles.priority_rank)

    return c.json(roles)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'roles_fetch_by_scope_failed',
      userId,
      scopeType,
      error,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
})
