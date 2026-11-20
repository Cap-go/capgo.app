-- Cooldown claim and restore for update.failure_spike MCP subscriptions (matches runner SQL).
BEGIN;

SELECT plan(11);

SELECT tests.authenticate_as_service_role();

DO $seed$
DECLARE
  v_webhook_id uuid := 'd7820000-0000-4000-8000-0000000000c1';
  v_org_id uuid := '046a36ac-e03c-4590-9257-bd6c9dba9ee8';
  v_user_id uuid := '6aa76066-55ef-4238-ade6-0b32334a4097';
BEGIN
  INSERT INTO public.webhooks (
    id,
    org_id,
    name,
    url,
    secret,
    enabled,
    events,
    created_at,
    updated_at,
    created_by,
    delivery_version,
    source,
    mcp_event,
    mcp_arguments,
    mcp_verified_at,
    expires_at,
    mcp_spike_last_fired_at
  )
  VALUES (
    v_webhook_id,
    v_org_id,
    'MCP failure spike claim test',
    'https://hooks.example.com/capgo/mcp/spike-claim-test',
    'whsec_test_spike_claim_pgtap',
    true,
    ARRAY['update.failure_spike']::text[],
    pg_catalog.now(),
    pg_catalog.now(),
    v_user_id,
    'standard',
    'mcp',
    'update.failure_spike',
    pg_catalog.jsonb_build_object(
      'org_id', v_org_id,
      'app_id', 'com.demo.app'
    ),
    pg_catalog.now(),
    NULL,
    NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET
    mcp_spike_last_fired_at = NULL,
    updated_at = pg_catalog.now();
END;
$seed$;

WITH claim AS (
  UPDATE public.webhooks AS w
  SET mcp_spike_last_fired_at = '2026-11-19T12:00:00+00'::timestamptz
  WHERE w.id = 'd7820000-0000-4000-8000-0000000000c1'::uuid
    AND (
      w.mcp_spike_last_fired_at IS NULL
      OR w.mcp_spike_last_fired_at <= '2026-11-19T11:45:00+00'::timestamptz
    )
  RETURNING w.id
)
SELECT ok(
  (SELECT count(*)::int FROM claim) = 1,
  'cooldown claim succeeds when mcp_spike_last_fired_at is null'
);

SELECT ok(
  (
    SELECT mcp_spike_last_fired_at
    FROM public.webhooks
    WHERE id = 'd7820000-0000-4000-8000-0000000000c1'::uuid
  ) = '2026-11-19T12:00:00+00'::timestamptz,
  'cooldown claim writes the new fired-at timestamp'
);

WITH blocked AS (
  UPDATE public.webhooks AS w
  SET mcp_spike_last_fired_at = '2026-11-19T12:15:00+00'::timestamptz
  WHERE w.id = 'd7820000-0000-4000-8000-0000000000c1'::uuid
    AND (
      w.mcp_spike_last_fired_at IS NULL
      OR w.mcp_spike_last_fired_at <= '2026-11-19T11:45:00+00'::timestamptz
    )
  RETURNING w.id
)
SELECT ok(
  (SELECT count(*)::int FROM blocked) = 0,
  'cooldown claim is skipped while still inside cooldown window'
);

WITH restore AS (
  UPDATE public.webhooks AS w
  SET mcp_spike_last_fired_at = '2026-11-19T10:00:00+00'::timestamptz
  WHERE w.id = 'd7820000-0000-4000-8000-0000000000c1'::uuid
    AND w.mcp_spike_last_fired_at = '2026-11-19T12:00:00+00'::timestamptz
  RETURNING w.id
)
SELECT ok(
  (SELECT count(*)::int FROM restore) = 1,
  'failed delivery restore reverts only our claim timestamp'
);

SELECT ok(
  pg_catalog.pg_get_functiondef(
    'public.process_all_cron_tasks()'::pg_catalog.regprocedure
  ) LIKE '%cron_mcp_failure_spike%',
  'process_all_cron_tasks enqueues and drains cron_mcp_failure_spike'
);

SELECT is(
  public.mcp_failure_spike_group_cursor_get(),
  0,
  'group cursor starts at zero'
);

WITH advanced AS (
  SELECT public.mcp_failure_spike_group_cursor_advance(2, 5) AS cursor
)
SELECT is((SELECT cursor FROM advanced), 2, 'group cursor advances by processed count');

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'anon',
    'public.mcp_failure_spike_group_cursor_get()',
    'EXECUTE'
  ),
  'anon cannot execute mcp_failure_spike_group_cursor_get'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.mcp_failure_spike_group_cursor_get()',
    'EXECUTE'
  ),
  'authenticated cannot execute mcp_failure_spike_group_cursor_get'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'anon',
    'public.mcp_failure_spike_group_cursor_advance(integer, integer)',
    'EXECUTE'
  ),
  'anon cannot execute mcp_failure_spike_group_cursor_advance'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.mcp_failure_spike_group_cursor_advance(integer, integer)',
    'EXECUTE'
  ),
  'authenticated cannot execute mcp_failure_spike_group_cursor_advance'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;