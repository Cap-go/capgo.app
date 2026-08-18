import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
/**
 * RBAC Permission System Tests
 *
 * Tests the RBAC permission functions and role binding enforcement.
 */
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ORG_ID, POSTGRES_URL, USER_ID, USER_ID_2, USER_PASSWORD_HASH } from './test-utils'

// Test constants
const TEST_APP_ID = 'com.demo.app'

describe('rbac permission system', () => {
  let pool: Pool
  let client: PoolClient

  const query = (text: string, params?: Array<string | number | null>) => {
    return client.query(text, params)
  }

  const withAuthClaim = async (userId: string) => {
    await query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claim.sub',
      userId,
    ])
    await query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claim.role',
      'authenticated',
    ])
    await query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claims',
      JSON.stringify({
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
      }),
    ])
  }

  const createApiKeyForOrg = async (key: string, name: string, orgId: string, roleName = 'org_super_admin') => {
    const apiKeyResult = await query(`
      INSERT INTO public.apikeys (user_id, key, name)
      VALUES ($1::uuid, $2, $3)
      RETURNING rbac_id
    `, [USER_ID, key, name])
    const apiKeyRbacId = apiKeyResult.rows[0]?.rbac_id
    expect(apiKeyRbacId).toBeTruthy()

    const bindingResult = await query(`
      INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
      SELECT
        'apikey',
        $1::uuid,
        roles.id,
        'org',
        $2::uuid,
        $3::uuid
      FROM public.roles
      WHERE roles.name = $4
      LIMIT 1
      RETURNING id
    `, [apiKeyRbacId, orgId, USER_ID, roleName])
    expect(bindingResult.rowCount).toBe(1)

    return apiKeyRbacId
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL })
  })

  beforeEach(async () => {
    client = await pool.connect()
    await client.query('BEGIN')
  })

  afterEach(async () => {
    if (!client)
      return
    try {
      await client.query('ROLLBACK')
    }
    finally {
      client.release()
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  describe('rbac_check_permission_direct SQL function', () => {
    describe('rbac permission inputs', () => {
      it('should allow app read permission for an authorized user', async () => {
        const result = await query(`
          SELECT public.rbac_check_permission_direct(
            'app.read',
            $1::uuid,
            $2::uuid,
            $3,
            NULL::bigint,
            NULL
          ) as allowed
        `, [USER_ID, ORG_ID, TEST_APP_ID])

        expect(result.rows[0].allowed).toBe(true)
      })

      it('should allow app upload permission for an authorized user', async () => {
        const result = await query(`
          SELECT public.rbac_check_permission_direct(
            'app.upload_bundle',
            $1::uuid,
            $2::uuid,
            $3,
            NULL::bigint,
            NULL
          ) as allowed
        `, [USER_ID, ORG_ID, TEST_APP_ID])

        expect(result.rows[0].allowed).toBe(true)
      })

      it('should deny permission for non-existent user', async () => {
        const fakeUserId = '00000000-0000-0000-0000-000000000000'
        const result = await query(`
          SELECT public.rbac_check_permission_direct(
            'app.read',
            $1::uuid,
            $2::uuid,
            $3,
            NULL::bigint,
            NULL
          ) as allowed
        `, [fakeUserId, ORG_ID, TEST_APP_ID])

        expect(result.rows[0].allowed).toBe(false)
      })

      it('should deny unknown permission', async () => {
        const result = await query(`
          SELECT public.rbac_check_permission_direct(
            'unknown.permission',
            $1::uuid,
            $2::uuid,
            $3,
            NULL::bigint,
            NULL
          ) as allowed
        `, [USER_ID, ORG_ID, TEST_APP_ID])

        expect(result.rows[0].allowed).toBe(false)
      })

      it('should deny org permissions outside bound org for api keys', async () => {
        const allowedOrgId = randomUUID()
        const targetOrgId = randomUUID()
        const scopedKey = `org-bound-${randomUUID()}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES
            ($1::uuid, $3, $5, $6::uuid),
            ($2::uuid, $4, $5, $6::uuid)
        `, [allowedOrgId, targetOrgId, `API Key Allowed ${allowedOrgId}`, `API Key Target ${targetOrgId}`, `org-bound-${randomUUID()}@capgo.app`, USER_ID])

        await createApiKeyForOrg(scopedKey, `Org bound ${allowedOrgId}`, allowedOrgId)

        const deniedResult = await query(`
          SELECT public.rbac_check_permission_direct(
            'org.delete',
            $1::uuid,
            $2::uuid,
            NULL::text,
            NULL::bigint,
            $3
          ) AS allowed
        `, [USER_ID, targetOrgId, scopedKey])

        const allowedResult = await query(`
          SELECT public.rbac_check_permission_direct(
            'org.delete',
            $1::uuid,
            $2::uuid,
            NULL::text,
            NULL::bigint,
            $3
          ) AS allowed
        `, [USER_ID, allowedOrgId, scopedKey])

        expect(deniedResult.rows[0].allowed).toBe(false)
        expect(allowedResult.rows[0].allowed).toBe(true)
      })

      it('should deny stale org_users rights when RBAC bindings are missing', async () => {
        const staleOrgId = randomUUID()
        const staleUserId = randomUUID()
        const staleEmail = `stale-rbac-${staleOrgId}@capgo.app`

        await query(`
          INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
          VALUES ($1::uuid, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)
        `, [staleUserId, staleEmail, USER_PASSWORD_HASH])

        await query(`
          INSERT INTO public.users (id, email, first_name, last_name)
          VALUES ($1::uuid, $2, 'Stale', 'Rights')
        `, [staleUserId, staleEmail])

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [staleOrgId, `Stale RBAC ${staleOrgId}`, staleEmail, USER_ID])

        await query(`
          INSERT INTO public.org_users (org_id, user_id, rbac_role_name)
          VALUES ($1::uuid, $2::uuid, public.rbac_role_org_super_admin())
        `, [staleOrgId, staleUserId])

        await query(`
          DELETE FROM public.role_bindings
          WHERE principal_type = public.rbac_principal_user()
            AND principal_id = $1::uuid
            AND org_id = $2::uuid
        `, [staleUserId, staleOrgId])

        const result = await query(`
          SELECT public.rbac_check_permission_direct(
            'org.delete',
            $1::uuid,
            $2::uuid,
            NULL::text,
            NULL::bigint,
            NULL
          ) AS allowed
        `, [staleUserId, staleOrgId])

        expect(result.rows[0].allowed).toBe(false)
      })
    })

    describe('rbac permission checks', () => {
      beforeEach(async () => {
        await query(`SELECT set_config('capgo.rbac_enabled', 'true', true)`)
      })

      afterEach(async () => {
        await query(`SELECT set_config('capgo.rbac_enabled', 'false', true)`)
      })

      it('should check permissions via RBAC system when enabled', async () => {
        // The user should have permissions via role_bindings
        const result = await query(`
          SELECT public.rbac_check_permission_direct(
            'app.read',
            $1::uuid,
            $2::uuid,
            $3,
            NULL::bigint,
            NULL
          ) as allowed
        `, [USER_ID, ORG_ID, TEST_APP_ID])

        // Should be allowed because user has role_bindings for this org
        expect(result.rows[0].allowed).toBe(true)
      })

      it('should keep org-scoped app permissions for a new app id before the app row exists', async () => {
        const newAppId = 'com.demo.precreate'
        const result = await query(`
          SELECT
            NOT EXISTS (
              SELECT 1
              FROM public.apps
              WHERE app_id = $3
            ) AS app_missing,
            public.rbac_has_permission(
              public.rbac_principal_user(),
              $1::uuid,
              'app.update_settings',
              $2::uuid,
              $3,
              NULL::bigint
            ) AS app_permission_allowed
        `, [USER_ID, ORG_ID, newAppId])

        expect(result.rows[0].app_missing).toBe(true)
        expect(result.rows[0].app_permission_allowed).toBe(true)
      })

      it('should allow notification-only API keys without device or settings access', async () => {
        const testSlug = randomUUID().slice(0, 8)
        const orgId = randomUUID()
        const appId = `com.rbac.notifications.${testSlug}`
        const apiKey = `notifications-key-${testSlug}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [orgId, `Notifications RBAC Org ${testSlug}`, `notifications-rbac-${testSlug}@capgo.app`, USER_ID])

        const appResult = await query(`
          INSERT INTO public.apps (app_id, name, icon_url, owner_org)
          VALUES ($1, $2, $3, $4::uuid)
          RETURNING id
        `, [appId, `Notifications RBAC App ${testSlug}`, 'https://example.com/icon.png', orgId])
        const appUuid = appResult.rows[0]?.id
        expect(appUuid).toBeTruthy()

        const apiKeyResult = await query(`
          INSERT INTO public.apikeys (user_id, key, name)
          VALUES ($1::uuid, $2, $3)
          RETURNING rbac_id
        `, [USER_ID, apiKey, `notifications-key-${testSlug}`])
        const apiKeyRbacId = apiKeyResult.rows[0]?.rbac_id
        expect(apiKeyRbacId).toBeTruthy()

        const bindingResult = await query(`
          INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by)
          SELECT
            public.rbac_principal_apikey(),
            $1::uuid,
            roles.id,
            public.rbac_scope_app(),
            $2::uuid,
            $3::uuid,
            $4::uuid
          FROM public.roles
          WHERE roles.name = 'app_notifications'
          LIMIT 1
          RETURNING id
        `, [apiKeyRbacId, orgId, appUuid, USER_ID])
        expect(bindingResult.rowCount).toBe(1)

        const result = await query(`
          SELECT
            public.rbac_check_permission_direct('app.manage_notifications', $1::uuid, $2::uuid, $3, NULL::bigint, $4) AS notifications_allowed,
            public.rbac_check_permission_direct('app.manage_devices', $1::uuid, $2::uuid, $3, NULL::bigint, $4) AS devices_allowed,
            public.rbac_check_permission_direct('app.update_settings', $1::uuid, $2::uuid, $3, NULL::bigint, $4) AS settings_allowed
        `, [USER_ID, orgId, appId, apiKey])

        expect(result.rows[0].notifications_allowed).toBe(true)
        expect(result.rows[0].devices_allowed).toBe(false)
        expect(result.rows[0].settings_allowed).toBe(false)
      })

      it('limits each app preview key to its auto-created channels and bundles', async () => {
        const slug = randomUUID().slice(0, 8)
        const orgId = randomUUID()
        const appId = `com.rbac.preview.${slug}`
        const apiKeyA = `preview-key-a-${slug}`
        const apiKeyB = `preview-key-b-${slug}`

        await query(`SELECT set_config('request.headers', '{}', true)`)

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [orgId, `Preview RBAC Org ${slug}`, `preview-rbac-${slug}@capgo.app`, USER_ID])

        const appResult = await query(`
          INSERT INTO public.apps (app_id, name, icon_url, owner_org)
          VALUES ($1, $2, 'https://example.com/icon.png', $3::uuid)
          RETURNING id
        `, [appId, `Preview RBAC App ${slug}`, orgId])
        const appUuid = appResult.rows[0]?.id
        expect(appUuid).toBeTruthy()

        const mainChannelResult = await query(`
          INSERT INTO public.channels (name, app_id, created_by, owner_org)
          VALUES ('production', $1, $2::uuid, $3::uuid)
          RETURNING id, rbac_id
        `, [appId, USER_ID, orgId])
        const mainChannelId = mainChannelResult.rows[0]?.id
        expect(mainChannelId).toBeTruthy()

        const apiKeyResult = await query(`
          INSERT INTO public.apikeys (user_id, key, name)
          VALUES
            ($1::uuid, $2, $3),
            ($1::uuid, $4, $5)
          RETURNING key, rbac_id
        `, [USER_ID, apiKeyA, `Preview key A ${slug}`, apiKeyB, `Preview key B ${slug}`])
        const apiKeyARbacId = apiKeyResult.rows.find(row => row.key === apiKeyA)?.rbac_id
        const apiKeyBRbacId = apiKeyResult.rows.find(row => row.key === apiKeyB)?.rbac_id
        expect(apiKeyARbacId).toBeTruthy()
        expect(apiKeyBRbacId).toBeTruthy()

        const parentBindings = await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_apikey(),
            api_key.rbac_id,
            role.id,
            public.rbac_scope_app(),
            $1::uuid,
            $2::uuid,
            $3::uuid,
            true
          FROM public.apikeys AS api_key
          INNER JOIN public.roles AS role
            ON role.name = 'app_preview'
          WHERE api_key.key IN ($4, $5)
          RETURNING id, principal_id, org_id, app_id
        `, [orgId, appUuid, USER_ID, apiKeyA, apiKeyB])
        expect(parentBindings.rowCount).toBe(2)
        const parentBindingA = parentBindings.rows.find(row => row.principal_id === apiKeyARbacId)
        const parentBindingB = parentBindings.rows.find(row => row.principal_id === apiKeyBRbacId)
        expect(parentBindingA).toMatchObject({
          org_id: orgId,
          app_id: appUuid,
        })
        expect(parentBindingB).toMatchObject({
          org_id: orgId,
          app_id: appUuid,
        })

        const createPreviewResources = async (apiKey: string, name: string) => {
          await query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ capgkey: apiKey })])
          const bundleResult = await query(`
            INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
            VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
            RETURNING id, created_by_apikey_rbac_id
          `, [appId, `bundle-${name}-${slug}`, orgId, USER_ID])
          const channelResult = await query(`
            INSERT INTO public.channels (name, app_id, created_by, owner_org)
            VALUES ($1, $2, $3::uuid, $4::uuid)
            RETURNING id, rbac_id
          `, [`preview-${name}-${slug}`, appId, USER_ID, orgId])

          return {
            bundleId: bundleResult.rows[0]?.id,
            bundleCreator: bundleResult.rows[0]?.created_by_apikey_rbac_id,
            channelId: channelResult.rows[0]?.id,
            channelRbacId: channelResult.rows[0]?.rbac_id,
          }
        }

        const previewA = await createPreviewResources(apiKeyA, 'a')
        const previewB = await createPreviewResources(apiKeyB, 'b')
        expect(previewA.bundleId).toBeTruthy()
        expect(previewA.channelId).toBeTruthy()
        expect(previewB.bundleId).toBeTruthy()
        expect(previewB.channelId).toBeTruthy()
        expect(previewA.bundleCreator).toBe(apiKeyARbacId)
        expect(previewB.bundleCreator).toBe(apiKeyBRbacId)

        const childBindingA = await query(`
          SELECT child.principal_id, child.parent_binding_id, child.org_id, child.app_id,
            child.channel_id, child.is_direct, role.name
          FROM public.role_bindings AS child
          INNER JOIN public.roles AS role ON role.id = child.role_id
          WHERE child.channel_id = $1::uuid
            AND role.name = 'channel_preview'
        `, [previewA.channelRbacId])
        const childBindingB = await query(`
          SELECT child.principal_id, child.parent_binding_id, child.org_id, child.app_id,
            child.channel_id, child.is_direct, role.name
          FROM public.role_bindings AS child
          INNER JOIN public.roles AS role ON role.id = child.role_id
          WHERE child.channel_id = $1::uuid
            AND role.name = 'channel_preview'
        `, [previewB.channelRbacId])
        expect(childBindingA.rows).toEqual([expect.objectContaining({
          principal_id: apiKeyARbacId,
          parent_binding_id: parentBindingA?.id,
          org_id: orgId,
          app_id: appUuid,
          channel_id: previewA.channelRbacId,
          is_direct: false,
          name: 'channel_preview',
        })])
        expect(childBindingB.rows).toEqual([expect.objectContaining({
          principal_id: apiKeyBRbacId,
          parent_binding_id: parentBindingB?.id,
          org_id: orgId,
          app_id: appUuid,
          channel_id: previewB.channelRbacId,
          is_direct: false,
          name: 'channel_preview',
        })])

        const channelPermissions = await query(`
          SELECT
            public.rbac_check_permission_direct('channel.read', $1::uuid, $2::uuid, $3, $4::bigint, $7) AS a_reads_own,
            public.rbac_check_permission_direct('channel.promote_bundle', $1::uuid, $2::uuid, $3, $4::bigint, $7) AS a_promotes_own,
            public.rbac_check_permission_direct('channel.delete', $1::uuid, $2::uuid, $3, $4::bigint, $7) AS a_deletes_own,
            public.rbac_check_permission_direct('channel.read', $1::uuid, $2::uuid, $3, $5::bigint, $7) AS a_reads_b,
            public.rbac_check_permission_direct('channel.promote_bundle', $1::uuid, $2::uuid, $3, $5::bigint, $7) AS a_promotes_b,
            public.rbac_check_permission_direct('channel.delete', $1::uuid, $2::uuid, $3, $5::bigint, $7) AS a_deletes_b,
            public.rbac_check_permission_direct('channel.promote_bundle', $1::uuid, $2::uuid, $3, $6::bigint, $7) AS a_promotes_main,
            public.rbac_check_permission_direct('channel.delete', $1::uuid, $2::uuid, $3, $6::bigint, $7) AS a_deletes_main,
            public.rbac_check_permission_direct('channel.promote_bundle', $1::uuid, $2::uuid, $3, $5::bigint, $8) AS b_promotes_own,
            public.rbac_check_permission_direct('channel.delete', $1::uuid, $2::uuid, $3, $5::bigint, $8) AS b_deletes_own,
            public.rbac_check_permission_direct('channel.promote_bundle', $1::uuid, $2::uuid, $3, $4::bigint, $8) AS b_promotes_a,
            public.rbac_check_permission_direct('channel.delete', $1::uuid, $2::uuid, $3, $4::bigint, $8) AS b_deletes_a
        `, [
          USER_ID,
          orgId,
          appId,
          previewA.channelId,
          previewB.channelId,
          mainChannelId,
          apiKeyA,
          apiKeyB,
        ])
        expect(channelPermissions.rows[0]).toMatchObject({
          a_reads_own: true,
          a_promotes_own: true,
          a_deletes_own: true,
          a_reads_b: false,
          a_promotes_b: false,
          a_deletes_b: false,
          a_promotes_main: false,
          a_deletes_main: false,
          b_promotes_own: true,
          b_deletes_own: true,
          b_promotes_a: false,
          b_deletes_a: false,
        })

        await query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ capgkey: apiKeyA })])
        const ownBundleUpdate = await query(`
          UPDATE public.app_versions
          SET comment = 'updated by preview key a'
          WHERE id = $1::bigint
          RETURNING id
        `, [previewA.bundleId])
        expect(ownBundleUpdate.rows).toEqual([{ id: previewA.bundleId }])

        await query('SAVEPOINT preview_cross_bundle_update')
        let crossBundleUpdateError: unknown
        try {
          await query(`
            UPDATE public.app_versions
            SET comment = 'attempted by preview key a'
            WHERE id = $1::bigint
          `, [previewB.bundleId])
        }
        catch (error) {
          crossBundleUpdateError = error
        }
        await query('ROLLBACK TO SAVEPOINT preview_cross_bundle_update')
        expect((crossBundleUpdateError as { message?: string } | undefined)?.message).toContain('PREVIEW_APIKEY_CAN_ONLY_MANAGE_OWN_BUNDLE')

        const movedBundleOrgId = randomUUID()
        const movedBundleAppId = `com.rbac.preview.moved.${slug}`
        await query(`
          CREATE TEMP TABLE preview_bundle_scope_test (
            id bigint PRIMARY KEY,
            app_id character varying NOT NULL,
            owner_org uuid NOT NULL,
            created_by_apikey_rbac_id uuid,
            comment text
          ) ON COMMIT DROP
        `)
        await query(`
          CREATE TRIGGER enforce_preview_bundle_ownership
          BEFORE INSERT OR UPDATE ON preview_bundle_scope_test
          FOR EACH ROW EXECUTE FUNCTION public.enforce_preview_bundle_ownership()
        `)

        await query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ capgkey: apiKeyB })])
        const scopeTestBundle = await query(`
          INSERT INTO preview_bundle_scope_test (id, app_id, owner_org, comment)
          VALUES (-1, $1, $2::uuid, 'created by preview key b')
          RETURNING created_by_apikey_rbac_id
        `, [appId, orgId])
        expect(scopeTestBundle.rows[0]?.created_by_apikey_rbac_id).toBe(apiKeyBRbacId)

        // app_versions prevents scope moves in production. This isolated trigger
        // table exercises the same UPDATE path, where mutable NEW values must not
        // hide a bundle created by key B from key A's old app/org scope.
        await query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ capgkey: apiKeyA })])
        await query('SAVEPOINT preview_cross_scope_bundle_update')
        let crossScopeBundleUpdateError: unknown
        try {
          await query(`
            UPDATE preview_bundle_scope_test
            SET app_id = $1, owner_org = $2::uuid
            WHERE id = -1
          `, [movedBundleAppId, movedBundleOrgId])
        }
        catch (error) {
          crossScopeBundleUpdateError = error
        }
        await query('ROLLBACK TO SAVEPOINT preview_cross_scope_bundle_update')
        expect((crossScopeBundleUpdateError as { message?: string } | undefined)?.message).toContain('PREVIEW_APIKEY_CAN_ONLY_MANAGE_OWN_BUNDLE')

        // The public endpoint checks the channel-scoped permission before making
        // its service-role write. Exercise the trigger's key-bound bundle guard
        // here, while the direct checks above prove the channel scope.
        const ownPromotion = await query(`
          UPDATE public.channels
          SET version = $1::bigint
          WHERE id = $2::bigint
          RETURNING id, version
        `, [previewA.bundleId, previewA.channelId])
        expect(ownPromotion.rows).toEqual([{
          id: previewA.channelId,
          version: previewA.bundleId,
        }])

        await query('SAVEPOINT preview_cross_bundle_promotion')
        let crossBundlePromotionError: unknown
        try {
          await query(`
            UPDATE public.channels
            SET version = $1::bigint
            WHERE id = $2::bigint
          `, [previewB.bundleId, previewA.channelId])
        }
        catch (error) {
          crossBundlePromotionError = error
        }
        await query('ROLLBACK TO SAVEPOINT preview_cross_bundle_promotion')
        expect((crossBundlePromotionError as { message?: string } | undefined)?.message).toContain('PREVIEW_APIKEY_CAN_ONLY_PROMOTE_OWN_BUNDLE')

        // Link A's bundle from an internal main-channel write. The direct
        // PostgREST-style update below must not let key A alter that shared
        // bundle, even though it created the bundle itself.
        await query(`SELECT set_config('request.headers', '{}', true)`)
        const mainPromotion = await query(`
          UPDATE public.channels
          SET version = $1::bigint
          WHERE id = $2::bigint
          RETURNING id, version
        `, [previewA.bundleId, mainChannelId])
        expect(mainPromotion.rows).toEqual([{
          id: mainChannelId,
          version: previewA.bundleId,
        }])

        await query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ capgkey: apiKeyA })])
        const unreferencedBundleResult = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
          RETURNING id
        `, [appId, `bundle-a-unreferenced-${slug}`, orgId, USER_ID])
        const unreferencedBundleId = unreferencedBundleResult.rows[0]?.id
        expect(unreferencedBundleId).toBeTruthy()
        await query('SET LOCAL ROLE anon')

        await query('SAVEPOINT preview_shared_bundle_update')
        let sharedBundleUpdateError: unknown
        try {
          await query(`
            UPDATE public.app_versions
            SET comment = 'attempted against a main-linked preview bundle'
            WHERE id = $1::bigint
          `, [previewA.bundleId])
        }
        catch (error) {
          sharedBundleUpdateError = error
        }
        await query('ROLLBACK TO SAVEPOINT preview_shared_bundle_update')
        expect((sharedBundleUpdateError as { message?: string } | undefined)?.message).toContain('PREVIEW_APIKEY_CANNOT_MUTATE_SHARED_BUNDLE')

        await query('SAVEPOINT preview_shared_bundle_soft_delete')
        let sharedBundleSoftDeleteError: unknown
        try {
          await query(`
            UPDATE public.app_versions
            SET deleted = true
            WHERE id = $1::bigint
          `, [previewA.bundleId])
        }
        catch (error) {
          sharedBundleSoftDeleteError = error
        }
        await query('ROLLBACK TO SAVEPOINT preview_shared_bundle_soft_delete')
        expect((sharedBundleSoftDeleteError as { message?: string } | undefined)?.message).toContain('PREVIEW_APIKEY_CANNOT_MUTATE_SHARED_BUNDLE')

        // RLS remains the defense in depth for direct PostgREST soft-deletes
        // of an otherwise unreferenced bundle. The service-role cleanup route
        // is intentionally the only preview lifecycle path that can delete it.
        await query('SAVEPOINT preview_unreferenced_bundle_soft_delete')
        let unreferencedBundleSoftDeleteError: unknown
        try {
          await query(`
            UPDATE public.app_versions
            SET deleted = true
            WHERE id = $1::bigint
          `, [unreferencedBundleId])
        }
        catch (error) {
          unreferencedBundleSoftDeleteError = error
        }
        await query('ROLLBACK TO SAVEPOINT preview_unreferenced_bundle_soft_delete')
        expect((unreferencedBundleSoftDeleteError as { message?: string } | undefined)?.message).toMatch(/row-level security/i)

        const foreignDeletion = await query(`
          DELETE FROM public.channels
          WHERE id IN ($1::bigint, $2::bigint)
          RETURNING id
        `, [previewB.channelId, mainChannelId])
        expect(foreignDeletion.rowCount).toBe(0)

        const ownDeletion = await query(`
          DELETE FROM public.channels
          WHERE id = $1::bigint
          RETURNING id
        `, [previewA.channelId])
        expect(ownDeletion.rows).toEqual([{ id: previewA.channelId }])

        await query('RESET ROLE')
      })

      it('serializes preview bundle lifecycle locks across promotion and deletion transactions', async () => {
        const holder = await pool.connect()
        const waiter = await pool.connect()
        const lockSeed = BigInt(Date.now()) * BigInt(1_000_000) + BigInt(Math.floor(Math.random() * 1_000_000))
        const lowerBundleId = lockSeed.toString()
        const higherBundleId = (lockSeed + BigInt(1)).toString()

        try {
          await holder.query('BEGIN')
          await holder.query(
            'SELECT public.lock_channel_bundle_lifecycle($1::bigint, $2::bigint)',
            [higherBundleId, lowerBundleId],
          )

          await waiter.query('BEGIN')
          await waiter.query(`SET LOCAL lock_timeout = '100ms'`)
          await expect(waiter.query(
            'SELECT public.lock_channel_bundle_lifecycle($1::bigint, $2::bigint)',
            [lowerBundleId, higherBundleId],
          )).rejects.toThrow(/lock timeout/i)
        }
        finally {
          await holder.query('ROLLBACK')
          await waiter.query('ROLLBACK')
          holder.release()
          waiter.release()
        }
      })

      it('preserves blank and trusted seed channel inserts in the promotion trigger', async () => {
        const requesterId = randomUUID()
        const suffix = randomUUID().slice(0, 8)
        const targetResult = await query(`
          SELECT app.app_id, app.owner_org, version.id AS version_id
          FROM public.apps AS app
          INNER JOIN public.app_versions AS version
            ON version.app_id = app.app_id
            AND version.owner_org = app.owner_org
            AND version.deleted = false
          WHERE app.app_id = $1
          ORDER BY version.id
          LIMIT 1
        `, [TEST_APP_ID])
        const target = targetResult.rows[0]
        if (!target)
          throw new Error('Missing active demo bundle for channel trigger test')

        await withAuthClaim(requesterId)
        await query(`SELECT set_config('request.headers', '{}', true)`)

        await query('SAVEPOINT channel_insert_requires_promotion')
        let denied: unknown
        try {
          await query(`
            INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
            VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          `, [`trigger-denied-${suffix}`, target.app_id, target.version_id, USER_ID, target.owner_org])
        }
        catch (error) {
          denied = error
        }
        await query('ROLLBACK TO SAVEPOINT channel_insert_requires_promotion')
        expect((denied as { message?: string } | undefined)?.message).toContain('PERMISSION_DENIED_CHANNEL_PROMOTE_BUNDLE')

        const blank = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, NULL, $3::uuid, $4::uuid)
          RETURNING version
        `, [`trigger-blank-${suffix}`, target.app_id, USER_ID, target.owner_org])
        expect(blank.rows).toEqual([{ version: null }])

        await query(`SELECT pg_catalog.set_config('capgo.seed_channel_targets', 'true', true)`)
        const seeded = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING version
        `, [`trigger-seeded-${suffix}`, target.app_id, target.version_id, USER_ID, target.owner_org])
        expect(Number(seeded.rows[0]?.version)).toBe(Number(target.version_id))
      })

      it('should map app-scoped channel RBAC permissions to legacy CLI permissions', async () => {
        const developerKey = `rbac-channel-developer-${randomUUID()}`
        const adminKey = `rbac-channel-admin-${randomUUID()}`

        const developerKeyResult = await query(`
          INSERT INTO public.apikeys (user_id, key, name)
          VALUES ($1::uuid, $2, $3)
          RETURNING rbac_id
        `, [USER_ID, developerKey, 'RBAC channel developer key'])

        const adminKeyResult = await query(`
          INSERT INTO public.apikeys (user_id, key, name)
          VALUES ($1::uuid, $2, $3)
          RETURNING rbac_id
        `, [USER_ID, adminKey, 'RBAC channel admin key'])

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_apikey(),
            $1::uuid,
            roles.id,
            public.rbac_scope_app(),
            $2::uuid,
            apps.id,
            $3::uuid,
            true
          FROM public.roles
          CROSS JOIN public.apps
          WHERE roles.name = public.rbac_role_app_developer()
            AND apps.app_id = $4
          LIMIT 1
        `, [developerKeyResult.rows[0].rbac_id, ORG_ID, USER_ID, TEST_APP_ID])

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_apikey(),
            $1::uuid,
            roles.id,
            public.rbac_scope_app(),
            $2::uuid,
            apps.id,
            $3::uuid,
            true
          FROM public.roles
          CROSS JOIN public.apps
          WHERE roles.name = public.rbac_role_app_admin()
            AND apps.app_id = $4
          LIMIT 1
        `, [adminKeyResult.rows[0].rbac_id, ORG_ID, USER_ID, TEST_APP_ID])

        const result = await query(`
          SELECT
            public.get_org_perm_for_apikey($1, $3) AS developer_perm,
            public.is_allowed_capgkey($1, ARRAY['write']::text[], $3::character varying) AS developer_write_allowed,
            public.rbac_check_permission_direct(
              public.rbac_perm_app_create_channel(),
              $4::uuid,
              $5::uuid,
              $3,
              NULL::bigint,
              $1
            ) AS developer_can_create_channel,
            public.rbac_check_permission_direct(
              public.rbac_perm_channel_delete(),
              $4::uuid,
              $5::uuid,
              $3,
              NULL::bigint,
              $1
            ) AS developer_can_delete_channel,
            public.get_org_perm_for_apikey($2, $3) AS admin_perm,
            public.rbac_check_permission_direct(
              public.rbac_perm_channel_delete(),
              $4::uuid,
              $5::uuid,
              $3,
              NULL::bigint,
              $2
            ) AS admin_can_delete_channel
        `, [developerKey, adminKey, TEST_APP_ID, USER_ID, ORG_ID])
        expect(result.rows[0].developer_perm).toBe('perm_write')
        expect(result.rows[0].developer_write_allowed).toBe(true)
        expect(result.rows[0].developer_can_create_channel).toBe(true)
        expect(result.rows[0].developer_can_delete_channel).toBe(false)
        expect(result.rows[0].admin_perm).toBe('perm_admin')
        expect(result.rows[0].admin_can_delete_channel).toBe(true)
      })

      it('maps every legacy mutation permission through both API key compatibility helpers', async () => {
        const testId = randomUUID()
        const compatibilityCases = [
          { permissionKey: 'app.update_settings', legacyRank: 'perm_write', compatibilityMode: 'write' },
          { permissionKey: 'app.create_channel', legacyRank: 'perm_write', compatibilityMode: 'write' },
          { permissionKey: 'app.manage_notifications', legacyRank: 'perm_write', compatibilityMode: 'write' },
          { permissionKey: 'app.manage_devices', legacyRank: 'perm_write', compatibilityMode: 'write' },
          { permissionKey: 'app.build_native', legacyRank: 'perm_write', compatibilityMode: 'write' },
          { permissionKey: 'channel.update_settings', legacyRank: 'perm_write', compatibilityMode: 'write' },
          { permissionKey: 'channel.promote_bundle', legacyRank: 'perm_upload', compatibilityMode: 'upload' },
          { permissionKey: 'channel.rollback_bundle', legacyRank: 'perm_write', compatibilityMode: 'write' },
          { permissionKey: 'channel.manage_forced_devices', legacyRank: 'perm_write', compatibilityMode: 'write' },
        ]

        for (const { permissionKey, legacyRank, compatibilityMode } of compatibilityCases) {
          const apiKey = `rbac-compatibility-${testId}-${permissionKey}`
          const apiKeyResult = await query(`
            INSERT INTO public.apikeys (user_id, key, name)
            VALUES ($1::uuid, $2, $3)
            RETURNING rbac_id
          `, [USER_ID, apiKey, `RBAC compatibility ${permissionKey} ${testId}`])
          const apiKeyRbacId = apiKeyResult.rows[0]?.rbac_id
          expect(apiKeyRbacId).toBeTruthy()

          const roleResult = await query(`
            INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable)
            VALUES ($1, public.rbac_scope_app(), $2, 0, false)
            RETURNING id
          `, [`legacy-compatibility-${testId}-${permissionKey}`, `Isolated compatibility permission ${permissionKey}`])
          const roleId = roleResult.rows[0]?.id
          expect(roleId).toBeTruthy()

          const rolePermissionResult = await query(`
            INSERT INTO public.role_permissions (role_id, permission_id)
            SELECT $1::uuid, permissions.id
            FROM public.permissions
            WHERE permissions.key = $2
            RETURNING role_id
          `, [roleId, permissionKey])
          expect(rolePermissionResult.rowCount).toBe(1)

          const bindingResult = await query(`
            INSERT INTO public.role_bindings (
              principal_type,
              principal_id,
              role_id,
              scope_type,
              org_id,
              app_id,
              granted_by,
              is_direct
            )
            SELECT
              public.rbac_principal_apikey(),
              $1::uuid,
              $2::uuid,
              public.rbac_scope_app(),
              $3::uuid,
              apps.id,
              $4::uuid,
              true
            FROM public.apps
            WHERE apps.app_id = $5
            RETURNING id
          `, [apiKeyRbacId, roleId, ORG_ID, USER_ID, TEST_APP_ID])
          expect(bindingResult.rowCount).toBe(1)

          const compatibility = await query(`
            SELECT
              public.get_org_perm_for_apikey($1, $2) AS legacy_rank,
              public.is_allowed_capgkey($1, ARRAY[$3::text], $2::character varying) AS allowed
          `, [apiKey, TEST_APP_ID, compatibilityMode])
          expect(compatibility.rows[0]).toMatchObject({
            legacy_rank: legacyRank,
            allowed: true,
          })
        }
      })

      it('should ignore role bindings whose role scope does not match the binding scope', async () => {
        const fakeUserId = '11111111-1111-4111-8111-111111111111'

        await query(`SET LOCAL session_replication_role = replica`)
        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            granted_at,
            reason,
            is_direct
          )
          SELECT
            public.rbac_principal_user(),
            $1::uuid,
            r.id,
            public.rbac_scope_app(),
            $2::uuid,
            a.id,
            $1::uuid,
            now(),
            'scope-mismatch-regression-test',
            true
          FROM public.roles r
          JOIN public.apps a ON a.app_id = $3
          WHERE r.name = public.rbac_role_org_super_admin()
        `, [fakeUserId, ORG_ID, TEST_APP_ID])

        const result = await query(`
          SELECT
            public.rbac_has_permission(
              public.rbac_principal_user(),
              $1::uuid,
              'app.update_settings',
              $2::uuid,
              $3,
              NULL::bigint
            ) AS app_permission_allowed
        `, [fakeUserId, ORG_ID, TEST_APP_ID])

        expect(result.rows[0].app_permission_allowed).toBe(false)
      })

      it('should ignore cross-scope hierarchy descendants during permission expansion', async () => {
        const fakeUserId = '22222222-2222-4222-8222-222222222222'

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            granted_at,
            reason,
            is_direct
          )
          SELECT
            public.rbac_principal_user(),
            $1::uuid,
            app_role.id,
            public.rbac_scope_app(),
            $2::uuid,
            a.id,
            $3::uuid,
            now(),
            'cross-scope-hierarchy-test',
            true
          FROM public.roles app_role
          JOIN public.apps a ON a.app_id = $4
          WHERE app_role.name = public.rbac_role_app_reader()
        `, [fakeUserId, ORG_ID, USER_ID, TEST_APP_ID])

        await query(`
          INSERT INTO public.role_hierarchy (parent_role_id, child_role_id)
          SELECT
            parent_role.id,
            child_role.id
          FROM public.roles parent_role
          JOIN public.roles child_role ON child_role.name = public.rbac_role_org_super_admin()
          WHERE parent_role.name = public.rbac_role_app_reader()
        `)

        const result = await query(`
          SELECT
            public.rbac_has_permission(
              public.rbac_principal_user(),
              $1::uuid,
              'org.update_user_roles',
              $2::uuid,
              $3,
              NULL::bigint
            ) AS org_permission_allowed,
            public.rbac_has_permission(
              public.rbac_principal_user(),
              $1::uuid,
              'app.read',
              $2::uuid,
              $3,
              NULL::bigint
          ) AS app_read_allowed
        `, [fakeUserId, ORG_ID, TEST_APP_ID])

        expect(result.rows[0].org_permission_allowed).toBe(false)
        expect(result.rows[0].app_read_allowed).toBe(true)
      })

      it('should ignore forged app-scoped bindings whose org_id does not match the target app owner', async () => {
        const victimOrgId = randomUUID()
        const victimAppUuid = randomUUID()
        const victimAppId = `com.rbac.forged.${randomUUID()}`

        await query(`
          INSERT INTO public.orgs (
            id,
            created_by,
            name,
            management_email
          ) VALUES ($1::uuid, $2::uuid, $3, $4)
        `, [
          victimOrgId,
          USER_ID_2,
          `RBAC Victim Org ${victimOrgId}`,
          `rbac-victim-${victimOrgId}@capgo.app`,
        ])

        await query(`
          INSERT INTO public.apps (
            id,
            app_id,
            icon_url,
            owner_org,
            name
          ) VALUES ($1::uuid, $2, $3, $4::uuid, $5)
        `, [
          victimAppUuid,
          victimAppId,
          'rbac-forged-binding-icon',
          victimOrgId,
          `RBAC Victim App ${victimAppId}`,
        ])

        const roleResult = await query(`
          SELECT id
          FROM public.roles
          WHERE name = 'app_admin'
          LIMIT 1
        `)
        const roleId = roleResult.rows[0]?.id
        expect(roleId).toBeTruthy()

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          ) VALUES (
            public.rbac_principal_user(),
            $1::uuid,
            $2::uuid,
            public.rbac_scope_app(),
            $3::uuid,
            $4::uuid,
            $1::uuid,
            true
          )
        `, [
          USER_ID,
          roleId,
          ORG_ID,
          victimAppUuid,
        ])

        const result = await query(`
          SELECT public.rbac_has_permission(
            public.rbac_principal_user(),
            $1::uuid,
            'app.update_settings',
            $2::uuid,
            $3,
            NULL::bigint
          ) AS allowed
        `, [
          USER_ID,
          ORG_ID,
          victimAppId,
        ])

        expect(result.rows[0].allowed).toBe(false)
      })

      it('should reject caller-supplied app and org scope when channel scope belongs elsewhere', async () => {
        const id = randomUUID()
        const foreignOrgId = randomUUID()
        const foreignAppId = `com.channel.scope.${id}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [foreignOrgId, `Channel Scope Org ${id}`, `channel-scope-${id}@capgo.app`, USER_ID_2])

        await query(`
          INSERT INTO public.apps (app_id, name, icon_url, owner_org)
          VALUES ($1, $2, $3, $4::uuid)
        `, [foreignAppId, `Channel Scope App ${id}`, 'https://example.com/icon.png', foreignOrgId])

        const versionResult = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, '1.0.0', $2::uuid, $3::uuid, 'r2-direct')
          RETURNING id
        `, [foreignAppId, foreignOrgId, USER_ID_2])

        const channelResult = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ('production', $1, $2::bigint, $3::uuid, $4::uuid)
          RETURNING id
        `, [foreignAppId, versionResult.rows[0].id, USER_ID_2, foreignOrgId])

        const result = await query(`
          SELECT public.rbac_has_permission(
            public.rbac_principal_user(),
            $1::uuid,
            'app.update_settings',
            $2::uuid,
            $3,
            $4::bigint
          ) AS allowed
        `, [USER_ID, ORG_ID, TEST_APP_ID, channelResult.rows[0].id])

        expect(result.rows[0].allowed).toBe(false)
      })

      it('should ignore forged channel-scoped bindings whose org_id and app_id do not match the target channel owner', async () => {
        const victimOrgId = randomUUID()
        const victimAppUuid = randomUUID()
        const victimAppId = `com.rbac.channel.${randomUUID()}`
        const victimVersionName = `rbac-channel-version-${randomUUID().slice(0, 8)}`
        const victimChannelName = `rbac-channel-${randomUUID().slice(0, 8)}`

        const attackerAppResult = await query(`
          SELECT id
          FROM public.apps
          WHERE app_id = $1
          LIMIT 1
        `, [TEST_APP_ID])
        const attackerAppUuid = attackerAppResult.rows[0]?.id
        expect(attackerAppUuid).toBeTruthy()

        await query(`
          INSERT INTO public.orgs (
            id,
            created_by,
            name,
            management_email
          ) VALUES ($1::uuid, $2::uuid, $3, $4)
        `, [
          victimOrgId,
          USER_ID_2,
          `RBAC Channel Victim Org ${victimOrgId}`,
          `rbac-channel-victim-${victimOrgId}@capgo.app`,
        ])

        await query(`
          INSERT INTO public.apps (
            id,
            app_id,
            icon_url,
            owner_org,
            name
          ) VALUES ($1::uuid, $2, $3, $4::uuid, $5)
        `, [
          victimAppUuid,
          victimAppId,
          'rbac-forged-channel-icon',
          victimOrgId,
          `RBAC Channel Victim App ${victimAppId}`,
        ])

        const versionResult = await query(`
          INSERT INTO public.app_versions (
            app_id,
            name,
            owner_org,
            user_id,
            checksum,
            storage_provider,
            r2_path,
            deleted
          ) VALUES (
            $1,
            $2,
            $3::uuid,
            $4::uuid,
            $5,
            'r2',
            $6,
            false
          )
          RETURNING id
        `, [
          victimAppId,
          victimVersionName,
          victimOrgId,
          USER_ID_2,
          `checksum-${victimVersionName}`,
          `orgs/${victimOrgId}/apps/${victimAppId}/${victimVersionName}.zip`,
        ])
        const victimVersionId = versionResult.rows[0]?.id
        expect(victimVersionId).toBeTruthy()

        const channelResult = await query(`
          INSERT INTO public.channels (
            app_id,
            name,
            version,
            owner_org,
            created_by,
            public,
            allow_emulator
          ) VALUES (
            $1,
            $2,
            $3::bigint,
            $4::uuid,
            $5::uuid,
            false,
            false
          )
          RETURNING id, rbac_id
        `, [
          victimAppId,
          victimChannelName,
          victimVersionId,
          victimOrgId,
          USER_ID_2,
        ])
        const victimChannelId = channelResult.rows[0]?.id
        const victimChannelRbacId = channelResult.rows[0]?.rbac_id
        expect(victimChannelId).toBeTruthy()
        expect(victimChannelRbacId).toBeTruthy()

        const roleResult = await query(`
          SELECT id
          FROM public.roles
          WHERE name = public.rbac_role_channel_admin()
          LIMIT 1
        `)
        const roleId = roleResult.rows[0]?.id
        expect(roleId).toBeTruthy()

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            channel_id,
            granted_by,
            is_direct
          ) VALUES (
            public.rbac_principal_user(),
            $1::uuid,
            $2::uuid,
            public.rbac_scope_channel(),
            $3::uuid,
            $4::uuid,
            $5::uuid,
            $1::uuid,
            true
          )
        `, [
          USER_ID,
          roleId,
          ORG_ID,
          attackerAppUuid,
          victimChannelRbacId,
        ])

        const result = await query(`
          SELECT public.rbac_has_permission(
            public.rbac_principal_user(),
            $1::uuid,
            public.rbac_perm_channel_update_settings(),
            $2::uuid,
            $3,
            $4::bigint
          ) AS allowed
        `, [
          USER_ID,
          ORG_ID,
          TEST_APP_ID,
          victimChannelId,
        ])

        expect(result.rows[0].allowed).toBe(false)
      })

      it('should let app readers see every channel in the app without channel write permissions', async () => {
        const testId = randomUUID()
        const readerUserId = randomUUID()
        const orgId = randomUUID()
        const appUuid = randomUUID()
        const appId = `com.rbac.app-reader-channel.${testId}`
        const otherOrgId = randomUUID()
        const otherAppUuid = randomUUID()
        const otherAppId = `com.rbac.app-reader-other.${testId}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES
            ($1::uuid, $2, $3, $4::uuid),
            ($5::uuid, $6, $7, $4::uuid)
        `, [
          orgId,
          `RBAC App Reader Channel ${testId}`,
          `rbac-app-reader-channel-${testId}@capgo.app`,
          USER_ID,
          otherOrgId,
          `RBAC App Reader Other ${testId}`,
          `rbac-app-reader-other-${testId}@capgo.app`,
        ])

        await query(`
          INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
          VALUES
            ($1::uuid, $2, $3, $4, $5::uuid),
            ($6::uuid, $7, $8, $4, $9::uuid)
        `, [
          appUuid,
          appId,
          `RBAC App Reader Channel App ${testId}`,
          'rbac-app-reader-channel-icon',
          orgId,
          otherAppUuid,
          otherAppId,
          `RBAC App Reader Other App ${testId}`,
          otherOrgId,
        ])

        const version = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
          RETURNING id
        `, [appId, `1.0.0-app-reader-${testId}`, orgId, USER_ID])

        const otherVersion = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
          RETURNING id
        `, [otherAppId, `1.0.0-app-reader-other-${testId}`, otherOrgId, USER_ID])

        const existingChannel = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING id
        `, [`existing-${testId}`, appId, version.rows[0].id, USER_ID, orgId])

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_user(),
            $1::uuid,
            r.id,
            public.rbac_scope_app(),
            $2::uuid,
            $3::uuid,
            $4::uuid,
            true
          FROM public.roles r
          WHERE r.name = public.rbac_role_app_reader()
        `, [readerUserId, orgId, appUuid, USER_ID])

        const futureChannel = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING id
        `, [`future-${testId}`, appId, version.rows[0].id, USER_ID, orgId])

        const otherChannel = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING id
        `, [`other-${testId}`, otherAppId, otherVersion.rows[0].id, USER_ID, otherOrgId])

        await withAuthClaim(readerUserId)
        await query('SET LOCAL ROLE authenticated')

        const appRows = await query(`
          SELECT app_id
          FROM public.apps
          WHERE app_id = $1
        `, [appId])
        expect(appRows.rowCount).toBe(1)

        const visibleChannels = await query(`
          SELECT name
          FROM public.channels
          WHERE app_id = $1
          ORDER BY name
        `, [appId])
        expect(visibleChannels.rows.map(row => row.name)).toEqual([
          `existing-${testId}`,
          `future-${testId}`,
        ])

        const otherChannelRows = await query(`
          SELECT id
          FROM public.channels
          WHERE id = $1::bigint
        `, [otherChannel.rows[0].id])
        expect(otherChannelRows.rowCount).toBe(0)

        const permissionResult = await query(`
          SELECT
            public.rbac_check_permission_request(public.rbac_perm_channel_read(), $1::uuid, $2, $3::bigint) AS can_read_existing,
            public.rbac_check_permission_request(public.rbac_perm_channel_read_history(), $1::uuid, $2, $4::bigint) AS can_read_future_history,
            public.rbac_check_permission_request(public.rbac_perm_channel_read_forced_devices(), $1::uuid, $2, $4::bigint) AS can_read_future_forced_devices,
            public.rbac_check_permission_request(public.rbac_perm_channel_read_audit(), $1::uuid, $2, $4::bigint) AS can_read_future_audit,
            public.rbac_check_permission_request(public.rbac_perm_channel_update_settings(), $1::uuid, $2, $3::bigint) AS can_update_channel,
            public.rbac_check_permission_request(public.rbac_perm_channel_promote_bundle(), $1::uuid, $2, $3::bigint) AS can_promote_bundle,
            public.rbac_check_permission_request(public.rbac_perm_channel_rollback_bundle(), $1::uuid, $2, $3::bigint) AS can_rollback_bundle,
            public.rbac_check_permission_request(public.rbac_perm_channel_manage_forced_devices(), $1::uuid, $2, $3::bigint) AS can_manage_forced_devices,
            public.rbac_check_permission_request(public.rbac_perm_channel_delete(), $1::uuid, $2, $3::bigint) AS can_delete_channel
        `, [orgId, appId, existingChannel.rows[0].id, futureChannel.rows[0].id])

        expect(permissionResult.rows[0]).toMatchObject({
          can_read_existing: true,
          can_read_future_history: true,
          can_read_future_forced_devices: true,
          can_read_future_audit: true,
          can_update_channel: false,
          can_promote_bundle: false,
          can_rollback_bundle: false,
          can_manage_forced_devices: false,
          can_delete_channel: false,
        })
      })

      it('should keep channel readers from seeing the parent app or sibling channels', async () => {
        const testId = randomUUID()
        const channelUserId = randomUUID()
        const orgId = randomUUID()
        const appUuid = randomUUID()
        const appId = `com.rbac.channel-reader-only.${testId}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [orgId, `RBAC Channel Reader Only ${testId}`, `rbac-channel-reader-only-${testId}@capgo.app`, USER_ID])

        await query(`
          INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
          VALUES ($1::uuid, $2, $3, $4, $5::uuid)
        `, [appUuid, appId, `RBAC Channel Reader Only App ${testId}`, 'rbac-channel-reader-only-icon', orgId])

        const version = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
          RETURNING id
        `, [appId, `1.0.0-channel-reader-only-${testId}`, orgId, USER_ID])

        const allowedChannel = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING id, rbac_id
        `, [`allowed-${testId}`, appId, version.rows[0].id, USER_ID, orgId])

        const siblingChannel = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING id
        `, [`sibling-${testId}`, appId, version.rows[0].id, USER_ID, orgId])

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            channel_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_user(),
            $1::uuid,
            r.id,
            public.rbac_scope_channel(),
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5::uuid,
            true
          FROM public.roles r
          WHERE r.name = public.rbac_role_channel_reader()
        `, [channelUserId, orgId, appUuid, allowedChannel.rows[0].rbac_id, USER_ID])

        await withAuthClaim(channelUserId)
        await query('SET LOCAL ROLE authenticated')

        const appRows = await query(`
          SELECT app_id
          FROM public.apps
          WHERE app_id = $1
        `, [appId])
        expect(appRows.rowCount).toBe(0)

        const allowedChannelRows = await query(`
          SELECT id
          FROM public.channels
          WHERE id = $1::bigint
        `, [allowedChannel.rows[0].id])
        expect(allowedChannelRows.rowCount).toBe(1)

        const siblingChannelRows = await query(`
          SELECT id
          FROM public.channels
          WHERE id = $1::bigint
        `, [siblingChannel.rows[0].id])
        expect(siblingChannelRows.rowCount).toBe(0)

        const permissionResult = await query(`
          SELECT
            public.rbac_check_permission_request(public.rbac_perm_channel_read(), $1::uuid, $2, $3::bigint) AS can_read_channel,
            public.rbac_check_permission_request(public.rbac_perm_app_read(), $1::uuid, $2, NULL::bigint) AS can_read_app
        `, [orgId, appId, allowedChannel.rows[0].id])

        expect(permissionResult.rows[0]).toMatchObject({
          can_read_channel: true,
          can_read_app: false,
        })
      })

      it('allows channel-scoped admin API keys to look up, update, and delete their bound channel without app read', async () => {
        const testId = randomUUID()
        const channelKeyOwnerId = randomUUID()
        const orgId = randomUUID()
        const appUuid = randomUUID()
        const appId = `com.rbac.channel-key-2fa.${testId}`
        const channelKey = `rbac-channel-key-2fa-${testId}`

        await query(`
          INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
          VALUES ($1::uuid, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)
        `, [channelKeyOwnerId, `channel-key-2fa-${testId}@capgo.app`, USER_PASSWORD_HASH])

        await query(`
          INSERT INTO public.users (id, email, first_name, last_name)
          VALUES ($1::uuid, $2, 'Channel', 'Key')
        `, [channelKeyOwnerId, `channel-key-2fa-${testId}@capgo.app`])

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by, enforcing_2fa)
          VALUES ($1::uuid, $2, $3, $4::uuid, true)
        `, [orgId, `RBAC Channel Key 2FA ${testId}`, `rbac-channel-key-2fa-${testId}@capgo.app`, USER_ID])

        await query(`
          INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
          VALUES ($1::uuid, $2, $3, $4, $5::uuid)
        `, [appUuid, appId, `RBAC Channel Key 2FA App ${testId}`, 'rbac-channel-key-2fa-icon', orgId])

        const channel = await query(`
          INSERT INTO public.channels (name, app_id, created_by, owner_org)
          VALUES ($1, $2, $3::uuid, $4::uuid)
          RETURNING id, rbac_id
        `, [`allowed-${testId}`, appId, USER_ID, orgId])

        const apiKeyResult = await query(`
          INSERT INTO public.apikeys (user_id, key, name)
          VALUES ($1::uuid, $2, $3)
          RETURNING rbac_id
        `, [channelKeyOwnerId, channelKey, `RBAC channel key 2FA ${testId}`])

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            channel_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_apikey(),
            $1::uuid,
            r.id,
            public.rbac_scope_channel(),
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5::uuid,
            true
          FROM public.roles r
          WHERE r.name = public.rbac_role_channel_admin()
        `, [apiKeyResult.rows[0].rbac_id, orgId, appUuid, channel.rows[0].rbac_id, USER_ID])

        const rawAccess = await query(`
          SELECT
            public.rbac_has_permission(public.rbac_principal_apikey(), $4::uuid, public.rbac_perm_channel_read(), $1::uuid, $2, $3::bigint) AS has_channel_read_binding,
            public.rbac_has_permission(public.rbac_principal_apikey(), $4::uuid, public.rbac_perm_app_read(), $1::uuid, $2, NULL::bigint) AS has_app_read_binding
        `, [orgId, appId, channel.rows[0].id, apiKeyResult.rows[0].rbac_id])
        expect(rawAccess.rows[0]).toMatchObject({
          has_channel_read_binding: true,
          has_app_read_binding: false,
        })

        await query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ capgkey: channelKey })])
        await query('SET LOCAL ROLE anon')

        const guardedAccess = await query(`
          SELECT
            public.rbac_check_permission_request(public.rbac_perm_channel_read(), $1::uuid, $2, $3::bigint) AS can_read_channel_after_2fa_gate,
            public.reject_access_due_to_2fa_for_app($2) AS rejects_for_2fa
        `, [orgId, appId, channel.rows[0].id])

        expect(guardedAccess.rows[0]).toMatchObject({
          can_read_channel_after_2fa_gate: true,
          rejects_for_2fa: true,
        })

        const visibleChannel = await query(
          'SELECT id FROM public.channels WHERE id = $1::bigint',
          [channel.rows[0].id],
        )
        expect(visibleChannel.rowCount).toBe(1)

        const updatedChannel = await query(
          'UPDATE public.channels SET allow_emulator = true WHERE id = $1::bigint RETURNING id, allow_emulator',
          [channel.rows[0].id],
        )
        expect(updatedChannel.rows).toEqual([{ id: channel.rows[0].id, allow_emulator: true }])

        const deletedChannel = await query(
          'DELETE FROM public.channels WHERE id = $1::bigint RETURNING id',
          [channel.rows[0].id],
        )
        expect(deletedChannel.rows).toEqual([{ id: channel.rows[0].id }])
      })

      it('should deny org permissions outside bound org for api keys', async () => {
        const allowedOrgId = randomUUID()
        const targetOrgId = randomUUID()
        const scopedKey = `rbac-bound-${randomUUID()}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES
            ($1::uuid, $3, $5, $6::uuid),
            ($2::uuid, $4, $5, $6::uuid)
        `, [allowedOrgId, targetOrgId, `RBAC Allowed ${allowedOrgId}`, `RBAC Target ${targetOrgId}`, `rbac-bound-${randomUUID()}@capgo.app`, USER_ID])

        await createApiKeyForOrg(scopedKey, `RBAC bound ${allowedOrgId}`, allowedOrgId)

        const deniedResult = await query(`
          SELECT public.rbac_check_permission_direct(
            'org.delete',
            $1::uuid,
            $2::uuid,
            NULL::text,
            NULL::bigint,
            $3
          ) AS allowed
        `, [USER_ID, targetOrgId, scopedKey])

        const allowedResult = await query(`
          SELECT public.rbac_check_permission_direct(
            'org.delete',
            $1::uuid,
            $2::uuid,
            NULL::text,
            NULL::bigint,
            $3
          ) AS allowed
        `, [USER_ID, allowedOrgId, scopedKey])

        expect(deniedResult.rows[0].allowed).toBe(false)
        expect(allowedResult.rows[0].allowed).toBe(true)
      })

      it('should block direct channel version updates when promote_bundle is denied for the channel', async () => {
        const testId = randomUUID()
        const orgId = randomUUID()
        const appUuid = randomUUID()
        const appId = `com.rbac.channel.promote-deny.${testId}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [orgId, `RBAC Promote Deny ${testId}`, `rbac-promote-deny-${testId}@capgo.app`, USER_ID])

        await query(`
          INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
          VALUES ($1::uuid, $2, $3, $4, $5::uuid)
        `, [appUuid, appId, `RBAC Promote Deny App ${testId}`, 'rbac-promote-deny-icon', orgId])

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_user(),
            $1::uuid,
            r.id,
            public.rbac_scope_app(),
            $2::uuid,
            $3::uuid,
            $1::uuid,
            true
          FROM public.roles r
          WHERE r.name = public.rbac_role_app_developer()
        `, [USER_ID, orgId, appUuid])

        const originalVersion = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
          RETURNING id
        `, [appId, `1.0.0-original-${testId}`, orgId, USER_ID])

        const nextVersion = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
          RETURNING id
        `, [appId, `1.0.0-next-${testId}`, orgId, USER_ID])

        const channel = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING id
        `, [`production-${testId}`, appId, originalVersion.rows[0].id, USER_ID, orgId])

        await query(`
          INSERT INTO public.channel_permission_overrides (
            principal_type,
            principal_id,
            channel_id,
            permission_key,
            is_allowed
          )
          VALUES (
            public.rbac_principal_user(),
            $1::uuid,
            $2::bigint,
            public.rbac_perm_channel_promote_bundle(),
            false
          )
        `, [USER_ID, channel.rows[0].id])

        await withAuthClaim(USER_ID)

        const permission = await query(`
          SELECT public.rbac_check_permission_request(
            public.rbac_perm_channel_promote_bundle(),
            $1::uuid,
            $2,
            $3::bigint
          ) AS allowed
        `, [orgId, appId, channel.rows[0].id])

        expect(permission.rows[0].allowed).toBe(false)

        await query('SAVEPOINT channel_version_denied')
        let deniedError: unknown
        try {
          await query(`
            UPDATE public.channels
            SET version = $1::bigint
            WHERE id = $2::bigint
          `, [nextVersion.rows[0].id, channel.rows[0].id])
        }
        catch (error) {
          deniedError = error
        }
        await query('ROLLBACK TO SAVEPOINT channel_version_denied')

        expect(deniedError).toBeTruthy()
        expect((deniedError as Error).message).toContain('PERMISSION_DENIED_CHANNEL_PROMOTE_BUNDLE')
      })

      it('should apply channel permission overrides to API key principals', async () => {
        const testId = randomUUID()
        const orgId = randomUUID()
        const appUuid = randomUUID()
        const appId = `com.rbac.apikey.channel-override.${testId}`
        const apiKey = `apikey-channel-override-${testId}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [orgId, `RBAC API Key Channel Override ${testId}`, `rbac-apikey-channel-${testId}@capgo.app`, USER_ID])

        await query(`
          INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
          VALUES ($1::uuid, $2, $3, $4, $5::uuid)
        `, [appUuid, appId, `RBAC API Key Channel Override App ${testId}`, 'rbac-apikey-channel-icon', orgId])

        const version = await query(`
          INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
          VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
          RETURNING id
        `, [appId, `1.0.0-apikey-channel-${testId}`, orgId, USER_ID])

        const channel = await query(`
          INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
          VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
          RETURNING id
        `, [`production-${testId}`, appId, version.rows[0].id, USER_ID, orgId])

        const apiKeyResult = await query(`
          INSERT INTO public.apikeys (user_id, key, name)
          VALUES ($1::uuid, $2, $3)
          RETURNING rbac_id
        `, [USER_ID, apiKey, `API Key Channel Override ${testId}`])
        const apiKeyRbacId = apiKeyResult.rows[0]?.rbac_id
        expect(apiKeyRbacId).toBeTruthy()

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_apikey(),
            $1::uuid,
            r.id,
            public.rbac_scope_app(),
            $2::uuid,
            $3::uuid,
            $4::uuid,
            true
          FROM public.roles r
          WHERE r.name = public.rbac_role_app_developer()
        `, [apiKeyRbacId, orgId, appUuid, USER_ID])

        const allowedBeforeOverride = await query(`
          SELECT public.rbac_check_permission_direct(
            public.rbac_perm_channel_promote_bundle(),
            $1::uuid,
            $2::uuid,
            $3,
            $4::bigint,
            $5
          ) AS allowed
        `, [USER_ID, orgId, appId, channel.rows[0].id, apiKey])

        expect(allowedBeforeOverride.rows[0].allowed).toBe(true)

        await query(`
          INSERT INTO public.channel_permission_overrides (
            principal_type,
            principal_id,
            channel_id,
            permission_key,
            is_allowed
          )
          VALUES (
            public.rbac_principal_apikey(),
            $1::uuid,
            $2::bigint,
            public.rbac_perm_channel_promote_bundle(),
            false
          )
        `, [apiKeyRbacId, channel.rows[0].id])

        const allowedAfterOverride = await query(`
          SELECT public.rbac_check_permission_direct(
            public.rbac_perm_channel_promote_bundle(),
            $1::uuid,
            $2::uuid,
            $3,
            $4::bigint,
            $5
          ) AS allowed
        `, [USER_ID, orgId, appId, channel.rows[0].id, apiKey])

        expect(allowedAfterOverride.rows[0].allowed).toBe(false)
      })

      it('hides denied channels and forced devices from an app-reader API key', async () => {
        const testId = randomUUID()
        const orgId = randomUUID()
        const appUuid = randomUUID()
        const appId = `com.rbac.apikey.channel-read-deny.${testId}`
        const apiKey = `apikey-channel-read-deny-${testId}`

        await query(`
          INSERT INTO public.orgs (id, name, management_email, created_by)
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `, [orgId, `RBAC API Key Channel Read Deny ${testId}`, `rbac-apikey-channel-read-deny-${testId}@capgo.app`, USER_ID])

        await query(`
          INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
          VALUES ($1::uuid, $2, $3, $4, $5::uuid)
        `, [appUuid, appId, `RBAC API Key Channel Read Deny App ${testId}`, 'rbac-apikey-channel-read-deny-icon', orgId])

        const channels = await query(`
          INSERT INTO public.channels (name, app_id, created_by, owner_org)
          VALUES
            ($1, $2, $3::uuid, $4::uuid),
            ($5, $2, $3::uuid, $4::uuid)
          RETURNING id, name
        `, [`denied-${testId}`, appId, USER_ID, orgId, `allowed-${testId}`])
        const deniedChannel = channels.rows.find(channel => channel.name === `denied-${testId}`)
        const allowedChannel = channels.rows.find(channel => channel.name === `allowed-${testId}`)
        expect(deniedChannel).toBeTruthy()
        expect(allowedChannel).toBeTruthy()

        await query(`
          INSERT INTO public.channel_devices (channel_id, app_id, device_id, owner_org)
          VALUES
            ($1::bigint, $2, $3, $4::uuid),
            ($5::bigint, $2, $6, $4::uuid)
        `, [deniedChannel.id, appId, `denied-device-${testId}`, orgId, allowedChannel.id, `allowed-device-${testId}`])

        const apiKeyResult = await query(`
          INSERT INTO public.apikeys (user_id, key, name)
          VALUES ($1::uuid, $2, $3)
          RETURNING rbac_id
        `, [USER_ID, apiKey, `API Key Channel Read Deny ${testId}`])
        const apiKeyRbacId = apiKeyResult.rows[0]?.rbac_id
        expect(apiKeyRbacId).toBeTruthy()

        await query(`
          INSERT INTO public.role_bindings (
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            app_id,
            granted_by,
            is_direct
          )
          SELECT
            public.rbac_principal_apikey(),
            $1::uuid,
            roles.id,
            public.rbac_scope_app(),
            $2::uuid,
            $3::uuid,
            $4::uuid,
            true
          FROM public.roles
          WHERE roles.name = public.rbac_role_app_reader()
        `, [apiKeyRbacId, orgId, appUuid, USER_ID])

        await query(`
          INSERT INTO public.channel_permission_overrides (
            principal_type,
            principal_id,
            channel_id,
            permission_key,
            is_allowed
          )
          VALUES
            (
              public.rbac_principal_apikey(),
              $1::uuid,
              $2::bigint,
              public.rbac_perm_channel_read(),
              false
            ),
            (
              public.rbac_principal_apikey(),
              $1::uuid,
              $2::bigint,
              public.rbac_perm_channel_read_forced_devices(),
              false
            )
        `, [apiKeyRbacId, deniedChannel.id])

        const effectivePermissions = await query(`
          SELECT
            public.rbac_check_permission_direct(
              public.rbac_perm_app_read(),
              $1::uuid,
              $2::uuid,
              $3,
              NULL::bigint,
              $4
            ) AS can_read_app,
            public.rbac_check_permission_direct(
              public.rbac_perm_channel_read(),
              $1::uuid,
              $2::uuid,
              $3,
              $5::bigint,
              $4
            ) AS can_read_denied_channel,
            public.rbac_check_permission_direct(
              public.rbac_perm_channel_read_forced_devices(),
              $1::uuid,
              $2::uuid,
              $3,
              $5::bigint,
              $4
            ) AS can_read_denied_forced_devices
        `, [USER_ID, orgId, appId, apiKey, deniedChannel.id])
        expect(effectivePermissions.rows[0]).toMatchObject({
          can_read_app: true,
          can_read_denied_channel: false,
          can_read_denied_forced_devices: false,
        })

        await query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify({ capgkey: apiKey })])
        await query('SET LOCAL ROLE anon')

        const visibleChannels = await query(`
          SELECT id
          FROM public.channels
          WHERE app_id = $1
          ORDER BY id
        `, [appId])
        expect(visibleChannels.rows).toEqual([{ id: allowedChannel.id }])

        const visibleDevices = await query(`
          SELECT channel_id
          FROM public.channel_devices
          WHERE app_id = $1
          ORDER BY channel_id
        `, [appId])
        expect(visibleDevices.rows).toEqual([{ channel_id: allowedChannel.id }])
      })
    })

    it('should reject unauthenticated access to get_org_user_access_rbac', async () => {
      let caught: unknown
      try {
        await query(`
          SELECT * FROM public.get_org_user_access_rbac($1::uuid, $2::uuid)
        `, [USER_ID, ORG_ID])
      }
      catch (error) {
        caught = error
      }

      expect(caught).toBeTruthy()
      expect((caught as { message?: string })?.message).toContain('NO_PERMISSION_TO_VIEW_BINDINGS')
    })

    it('should allow authenticated user when requesting their own bindings', async () => {
      await withAuthClaim(USER_ID)

      const result = await query(`
        SELECT * FROM public.get_org_user_access_rbac($1::uuid, $2::uuid)
      `, [USER_ID, ORG_ID])

      expect(Array.isArray(result.rows)).toBe(true)
    })
  })
})
