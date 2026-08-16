import type { Pool } from 'pg'
import { Pool as PgPool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

interface ProcState {
  anon_exec: boolean
  auth_exec: boolean
  proc: string
  prosecdef: boolean
}

const INVOKER_PROCS = [
  'public.get_apikey_header()',
  'public.is_apikey_expired(timestamp with time zone)',
  'public.strip_html(text)',
  'public.verify_api_key_hash(text, text)',
] as const

const SERVICE_ONLY_PROCS = [
  'public.apikey_has_current_org_create_capability(uuid)',
  'public.apikey_has_global_permission(text, text)',
  'public.apikeys_force_server_key()',
  'public.apikeys_strip_plain_key_for_hashed()',
  'public.assert_effective_super_admin_binding_removal(uuid, text)',
  'public.prevent_role_binding_priority_escalation()',
  'public.check_encrypted_bundle_on_insert()',
  'public.check_org_hashed_key_enforcement(uuid, public.apikeys)',
  'public.cleanup_onboarding_app_data_on_complete()',
  'public.delete_old_deleted_versions()',
  'public.long_canceled_org_ids()',
  'public.canceled_org_ids_past_grace(integer)',
  'public.process_free_trial_expired()',
  'public.soft_delete_versions_for_long_canceled_orgs(integer)',
  'public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer)',
  'public.cleanup_long_canceled_org_data()',
  'public.queue_canceled_org_retention_alerts(text, integer, integer)',
  'public.delete_apps_for_long_canceled_orgs(integer)',
  'public.enqueue_credit_usage_posthog_event()',
  'public.generate_org_user_stripe_info_on_org_create()',
  'public.get_apikey()',
  'public.get_org_members(uuid, uuid)',
  'public.noupdate()',
  'public.prevent_last_super_admin_binding_delete()',
  'public.prevent_last_super_admin_binding_update()',
  'public.process_all_cron_tasks()',
  'public.reassign_webhook_created_by_before_user_delete()',
  'public.sanitize_apps_text_fields()',
  'public.sanitize_orgs_text_fields()',
  'public.sanitize_tmp_users_text_fields()',
  'public.sanitize_users_text_fields()',
  'public.set_webhook_created_by()',
  'public.sync_org_has_usage_credits_from_grants()',
  'public.is_platform_admin_listed(uuid)',
  'public.is_active_platform_impersonation()',
  'public.cleanup_expired_platform_impersonation_sessions()',
] as const

const REMOVED_OLD_RIGHTS_PROCS = [
  'public.resync_org_user_role_bindings(uuid, uuid)',
  'public.sync_org_user_role_binding_on_delete()',
  'public.sync_org_user_role_binding_on_update()',
  'public.sync_org_user_to_role_binding()',
] as const

const ANON_ALLOWED_PROCS = [
  'public.get_app_metrics(uuid, character varying, date, date)',
  'public.get_app_metrics(uuid, date, date)',
  'public.check_org_members_2fa_enabled(uuid)',
  'public.check_org_members_password_policy(uuid)',
  'public.get_org_members(uuid)',
  'public.get_org_members_rbac(uuid)',
  'public.get_channel_current_bundle_rbac(character varying, bigint)',
  'public.get_total_app_storage_size_orgs(uuid, character varying)',
  'public.get_total_storage_size_org(uuid)',
  'public.get_user_main_org_id_by_app_id(text)',
  'public.get_user_org_ids()',
  'public.has_2fa_enabled()',
  'public.invite_user_to_org_rbac(character varying, uuid, text)',
  'public.is_allowed_action_org(uuid)',
  'public.is_allowed_action_org_action(uuid, public.action_type[])',
  'public.is_canceled_org(uuid)',
  'public.is_good_plan_v5_org(uuid)',
  'public.is_onboarded_org(uuid)',
  'public.is_onboarding_needed_org(uuid)',
  'public.is_org_yearly(uuid)',
  'public.is_paying_and_good_plan_org(uuid)',
  'public.reject_access_due_to_2fa_for_app(character varying)',
  'public.reject_access_due_to_2fa_for_org(uuid)',
  'public.request_actor_user_id()',
  'public.update_org_invite_role_rbac(uuid, uuid, text)',
  'public.update_tmp_invite_role_rbac(uuid, text, text)',
  'public.verify_mfa()',
] as const

const AUTHENTICATED_ONLY_PROCS = [
  'public.accept_invitation_to_org(uuid)',
  'public.acknowledge_compatibility_event(bigint, text)',
  'public.count_non_compliant_bundles(uuid, text)',
  'public.delete_group_with_bindings(uuid)',
  'public.delete_non_compliant_bundles(uuid, text)',
  'public.delete_org_member_role(uuid, uuid)',
  'public.delete_user()',
  'public.get_account_removal_date()',
  'public.get_app_access_rbac(uuid)',
  'public.get_app_metrics(uuid)',
  'public.get_org_user_access_rbac(uuid, uuid)',
  'public.rbac_check_permission(text, uuid, character varying, bigint)',
  'public.rbac_check_permission_no_password_policy(text, uuid, character varying, bigint)',
  'public.update_org_member_role(uuid, uuid, text)',
  'public.verify_email_otp_auth()',
] as const

describe('security definer execute hardening', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new PgPool({ connectionString: POSTGRES_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function getProcStates(procs: readonly string[]): Promise<Map<string, ProcState>> {
    const result = await pool.query<ProcState>(`
      WITH requested AS (
        SELECT
          proc,
          to_regprocedure(proc) AS proc_oid
        FROM unnest($1::text[]) AS proc
      )
      SELECT
        requested.proc,
        p.prosecdef,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM requested
      LEFT JOIN pg_proc AS p
        ON p.oid = requested.proc_oid
      ORDER BY 1
    `, [procs])

    return new Map(result.rows.map(row => [row.proc, row]))
  }

  function assertProcExists(states: Map<string, ProcState>, proc: string) {
    expect(states.get(proc)?.prosecdef, `${proc} does not exist or signature mismatch`).not.toBeNull()
  }

  it.concurrent('runs pure helpers as security invoker', async () => {
    const states = await getProcStates(INVOKER_PROCS)

    expect(states.size).toBe(INVOKER_PROCS.length)

    for (const proc of INVOKER_PROCS) {
      assertProcExists(states, proc)
      expect(states.get(proc)?.prosecdef, proc).toBe(false)
    }
  })

  it.concurrent('keeps helper behavior intact', async () => {
    const result = await pool.query<{
      expired_null: boolean
      stripped: string
      verified: boolean
    }>(`
      SELECT
        public.is_apikey_expired(NULL) AS expired_null,
        public.strip_html('<b>capgo</b>') AS stripped,
        public.verify_api_key_hash(
          'capgo',
          encode(extensions.digest('capgo', 'sha256'), 'hex')
        ) AS verified
    `)

    expect(result.rows[0]).toEqual({
      expired_null: false,
      stripped: 'capgo',
      verified: true,
    })
  })

  it.concurrent('blocks direct execution of service-only helpers', async () => {
    const states = await getProcStates(SERVICE_ONLY_PROCS)

    expect(states.size).toBe(SERVICE_ONLY_PROCS.length)

    for (const proc of SERVICE_ONLY_PROCS) {
      assertProcExists(states, proc)
      const state = states.get(proc)
      expect(state?.anon_exec, proc).toBe(false)
      expect(state?.auth_exec, proc).toBe(false)
    }
  })

  it.concurrent('removes old org_users to role_bindings sync helpers', async () => {
    const result = await pool.query<{ proc: string, proc_oid: string | null }>(`
      SELECT
        proc,
        to_regprocedure(proc)::text AS proc_oid
      FROM unnest($1::text[]) AS proc
      ORDER BY 1
    `, [REMOVED_OLD_RIGHTS_PROCS])

    expect(result.rows).toHaveLength(REMOVED_OLD_RIGHTS_PROCS.length)
    for (const row of result.rows) {
      expect(row.proc_oid, row.proc).toBeNull()
    }
  })

  it.concurrent('keeps anon-safe helpers callable for anonymous callers', async () => {
    const states = await getProcStates(ANON_ALLOWED_PROCS)

    expect(states.size).toBe(ANON_ALLOWED_PROCS.length)

    for (const proc of ANON_ALLOWED_PROCS) {
      assertProcExists(states, proc)
      const state = states.get(proc)
      expect(state?.anon_exec, proc).toBe(true)
      expect(state?.auth_exec, proc).toBe(true)
    }
  })

  it.concurrent('keeps signed-in RPCs inaccessible to anonymous callers', async () => {
    const states = await getProcStates(AUTHENTICATED_ONLY_PROCS)

    expect(states.size).toBe(AUTHENTICATED_ONLY_PROCS.length)

    for (const proc of AUTHENTICATED_ONLY_PROCS) {
      assertProcExists(states, proc)
      const state = states.get(proc)
      expect(state?.anon_exec, proc).toBe(false)
      expect(state?.auth_exec, proc).toBe(true)
    }
  })
})
