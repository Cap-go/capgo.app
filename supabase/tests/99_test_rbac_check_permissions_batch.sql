-- public.rbac_check_permissions (batch) must return exactly what the single
-- checks return for every entry: rbac_check_permission for auth.uid() entries,
-- rbac_check_permission_direct for entries carrying user_id / apikey.
BEGIN;

SELECT plan(34);

-- Every permission key x a mix of org / app / channel / mismatched scopes.
-- Built as postgres so authenticated callers do not need table access.
CREATE OR REPLACE FUNCTION tests.rbac_batch_matrix(
  p_user_id uuid DEFAULT NULL,
  p_apikey text DEFAULT NULL,
  p_with_principal boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH scopes(org_id, app_id, channel_id) AS (
    VALUES
      ('046a36ac-e03c-4590-9257-bd6c9dba9ee8'::text, NULL::text, NULL::bigint),
      ('34a8c55d-2d0f-4652-a43f-684c7a9403ac', NULL, NULL),
      ('acde0000-0000-4000-8000-0000000000a1', NULL, NULL),
      (NULL, 'com.demo.app', NULL),
      ('046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.demo.app', NULL),
      (NULL, 'com.test2.app', NULL),
      (NULL, NULL, 1),
      (NULL, 'com.demo.app', 1),
      (NULL, NULL, 6),
      -- org / app mismatch: scope resolution must deny in both paths
      ('34a8c55d-2d0f-4652-a43f-684c7a9403ac', 'com.demo.app', NULL)
  )
  SELECT jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'key', p.key || '@' || COALESCE(s.org_id, '-') || '/' || COALESCE(s.app_id, '-') || '/' || COALESCE(s.channel_id::text, '-'),
      'permission_key', p.key,
      'org_id', s.org_id,
      'app_id', s.app_id,
      'channel_id', s.channel_id
    ))
    || CASE WHEN p_with_principal THEN jsonb_build_object('user_id', p_user_id, 'apikey', p_apikey) ELSE '{}'::jsonb END
    ORDER BY p.key, s.org_id, s.app_id, s.channel_id
  )
  FROM public.permissions p
  CROSS JOIN scopes s;
$$;

-- Runs as the current role: compares every batch row with the single check.
CREATE OR REPLACE FUNCTION tests.rbac_batch_parity(p_checks jsonb)
RETURNS TABLE (total integer, mismatches integer, allowed_count integer, ordered boolean)
LANGUAGE sql
SET search_path = ''
AS $$
  WITH batch AS (
    SELECT b.idx, b.key, b.allowed, row_number() OVER () - 1 AS position
    FROM public.rbac_check_permissions(p_checks) AS b
  ),
  expected AS (
    SELECT
      b.idx,
      b.allowed,
      b.key IS NOT DISTINCT FROM (p_checks -> b.idx ->> 'key') AND b.position = b.idx AS in_order,
      CASE
        WHEN (p_checks -> b.idx) ? 'user_id' OR (p_checks -> b.idx) ? 'apikey' THEN
          COALESCE(public.rbac_check_permission_direct(
            p_checks -> b.idx ->> 'permission_key',
            (p_checks -> b.idx ->> 'user_id')::uuid,
            (p_checks -> b.idx ->> 'org_id')::uuid,
            (p_checks -> b.idx ->> 'app_id')::character varying,
            (p_checks -> b.idx ->> 'channel_id')::bigint,
            p_checks -> b.idx ->> 'apikey'
          ), false)
        ELSE
          COALESCE(public.rbac_check_permission(
            p_checks -> b.idx ->> 'permission_key',
            (p_checks -> b.idx ->> 'org_id')::uuid,
            (p_checks -> b.idx ->> 'app_id')::character varying,
            (p_checks -> b.idx ->> 'channel_id')::bigint
          ), false)
      END AS single_allowed
    FROM batch b
  )
  SELECT
    count(*)::integer,
    (count(*) FILTER (WHERE e.allowed IS DISTINCT FROM e.single_allowed))::integer,
    (count(*) FILTER (WHERE e.allowed))::integer,
    bool_and(e.in_order)
  FROM expected e;
$$;

GRANT EXECUTE ON FUNCTION tests.rbac_batch_matrix(uuid, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION tests.rbac_batch_parity(jsonb) TO authenticated, service_role, anon;

CREATE TABLE tests.rbac_batch_results (
  scenario text PRIMARY KEY,
  total integer,
  expected_total integer,
  mismatches integer,
  allowed_count integer,
  ordered boolean
);
GRANT ALL ON tests.rbac_batch_results TO authenticated, service_role;

CREATE OR REPLACE FUNCTION tests.record_rbac_batch_scenario(p_scenario text, p_checks jsonb)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  INSERT INTO tests.rbac_batch_results
  SELECT p_scenario, r.total, jsonb_array_length(p_checks), r.mismatches, r.allowed_count, r.ordered
  FROM tests.rbac_batch_parity(p_checks) AS r;
$$;
GRANT EXECUTE ON FUNCTION tests.record_rbac_batch_scenario(text, jsonb) TO authenticated, service_role;

-- Scenario 1-3: signed-in users checking themselves (rbac_check_permission path).
SELECT tests.authenticate_as('test_user');
SELECT tests.record_rbac_batch_scenario('user self', tests.rbac_batch_matrix());
SELECT tests.authenticate_as('test_admin');
SELECT tests.record_rbac_batch_scenario('admin self', tests.rbac_batch_matrix());
SELECT tests.authenticate_as('test_user2');
SELECT tests.record_rbac_batch_scenario('user2 self', tests.rbac_batch_matrix());

-- Scenario 4: explicit user principal for yourself (direct path).
SELECT tests.authenticate_as('test_user');
SELECT tests.record_rbac_batch_scenario(
  'user direct self',
  tests.rbac_batch_matrix(tests.get_supabase_uid('test_user'), NULL, true)
);

-- Scenario 5: another member's permissions (direct path, caller binding).
SELECT tests.record_rbac_batch_scenario(
  'user checks admin',
  tests.rbac_batch_matrix(tests.get_supabase_uid('test_admin'), NULL, true)
);

-- Scenario 6: a member of other orgs (caller binding limits it to shared orgs).
SELECT tests.record_rbac_batch_scenario(
  'user checks user2',
  tests.rbac_batch_matrix(tests.get_supabase_uid('test_user2'), NULL, true)
);

-- Scenarios 7-10: API-key principals evaluated by the backend (service role).
SELECT tests.authenticate_as_service_role();
SELECT tests.record_rbac_batch_scenario(
  'apikey org super admin',
  tests.rbac_batch_matrix(tests.get_supabase_uid('test_user'), 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea', true)
);
SELECT tests.record_rbac_batch_scenario(
  'apikey app reader',
  tests.rbac_batch_matrix(tests.get_supabase_uid('test_user'), '67eeaff4-ae4c-49a6-8eb1-0875f5369de0', true)
);
SELECT tests.record_rbac_batch_scenario(
  'apikey expired',
  tests.rbac_batch_matrix(tests.get_supabase_uid('test_user'), 'expired-plain-key-for-test', true)
);
SELECT tests.record_rbac_batch_scenario(
  'apikey owner mismatch',
  tests.rbac_batch_matrix(tests.get_supabase_uid('test_admin'), 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea', true)
);

-- Scenario 11: org enforcing 2FA denies users without 2FA in both paths.
SELECT tests.clear_authentication();
SET LOCAL role postgres;
UPDATE public.orgs SET enforcing_2fa = true WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';
SELECT tests.authenticate_as('test_user');
SELECT tests.record_rbac_batch_scenario('user self 2fa enforced', tests.rbac_batch_matrix());
SELECT tests.clear_authentication();
SET LOCAL role postgres;
UPDATE public.orgs SET enforcing_2fa = false WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

-- Parity: every scenario evaluates every entry, in order, with zero mismatches.
SELECT is(
  (SELECT count(*)::integer FROM tests.rbac_batch_results),
  11,
  'all parity scenarios ran'
);
SELECT is(
  (SELECT count(*)::integer FROM tests.rbac_batch_results WHERE total = expected_total AND expected_total > 0),
  11,
  'batch returns one row per input entry in every scenario'
);
SELECT is(
  (SELECT count(*)::integer FROM tests.rbac_batch_results WHERE ordered),
  11,
  'batch rows keep input order and echo each key'
);
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'user self'), 0, 'user self: batch matches rbac_check_permission');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'admin self'), 0, 'admin self: batch matches rbac_check_permission');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'user2 self'), 0, 'user2 self: batch matches rbac_check_permission');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'user direct self'), 0, 'direct user self: batch matches rbac_check_permission_direct');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'user checks admin'), 0, 'direct other member: batch matches rbac_check_permission_direct');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'user checks user2'), 0, 'direct member of other orgs: batch matches rbac_check_permission_direct');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'apikey org super admin'), 0, 'apikey org super admin: batch matches rbac_check_permission_direct');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'apikey app reader'), 0, 'apikey app reader: batch matches rbac_check_permission_direct');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'apikey expired'), 0, 'expired apikey: batch matches rbac_check_permission_direct');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'apikey owner mismatch'), 0, 'apikey owner mismatch: batch matches rbac_check_permission_direct');
SELECT is((SELECT mismatches FROM tests.rbac_batch_results WHERE scenario = 'user self 2fa enforced'), 0, '2FA enforced org: batch matches rbac_check_permission');

-- The matrix is not vacuous: grants and denials both occur where expected.
SELECT ok(
  (SELECT allowed_count > 0 AND allowed_count < total FROM tests.rbac_batch_results WHERE scenario = 'user self'),
  'user self matrix mixes allowed and denied checks'
);
SELECT ok(
  (SELECT allowed_count > 0 AND allowed_count < total FROM tests.rbac_batch_results WHERE scenario = 'user checks admin'),
  'other-member matrix mixes allowed and denied checks'
);
SELECT ok(
  (SELECT allowed_count > 0 AND allowed_count < total FROM tests.rbac_batch_results WHERE scenario = 'apikey org super admin'),
  'apikey matrix mixes allowed and denied checks'
);
SELECT ok(
  (SELECT allowed_count > 0 AND allowed_count < total FROM tests.rbac_batch_results WHERE scenario = 'apikey app reader'),
  'app reader apikey matrix mixes allowed and denied checks'
);
SELECT is((SELECT allowed_count FROM tests.rbac_batch_results WHERE scenario = 'apikey expired'), 0, 'expired apikey is denied everything');
SELECT is((SELECT allowed_count FROM tests.rbac_batch_results WHERE scenario = 'apikey owner mismatch'), 0, 'apikey with a mismatched user is denied everything');
SELECT ok(
  (SELECT r2.allowed_count < r1.allowed_count
   FROM tests.rbac_batch_results r1, tests.rbac_batch_results r2
   WHERE r1.scenario = 'user self' AND r2.scenario = 'user self 2fa enforced'),
  '2FA enforcement removes grants on the enforcing org'
);

-- Input handling.
SELECT tests.authenticate_as('test_user');
SELECT is(
  (SELECT array_agg(allowed ORDER BY idx) FROM public.rbac_check_permissions(jsonb_build_array(
    jsonb_build_object('permission_key', 'org.read', 'org_id', 'not-a-uuid'),
    jsonb_build_object('permission_key', 'channel.read', 'channel_id', '1.5'),
    jsonb_build_object('permission_key', 'org.read', 'org_id', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'user_id', 'nope'),
    '"not an object"'::jsonb,
    jsonb_build_object('org_id', '046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
    jsonb_build_object('permission_key', 'org.read', 'org_id', '046a36ac-e03c-4590-9257-bd6c9dba9ee8')
  ))),
  ARRAY[false, false, false, false, false, true],
  'malformed entries are denied without failing the rest of the batch'
);
SELECT is(
  (SELECT count(*)::integer FROM public.rbac_check_permissions('[]'::jsonb)),
  0,
  'empty batch returns no rows'
);
SELECT is(
  (SELECT allowed FROM public.rbac_check_permissions(jsonb_build_array(
    jsonb_build_object('permission_key', 'channel.read', 'channel_id', 1)
  ))),
  public.rbac_check_permission('channel.read', NULL, NULL, 1),
  'numeric channel_id is accepted like the single check'
);
SELECT throws_ok(
  $$SELECT * FROM public.rbac_check_permissions('{"permission_key":"org.read"}'::jsonb)$$,
  '22023',
  'p_checks must be a JSON array',
  'non-array input is rejected'
);
SELECT throws_ok(
  $$SELECT * FROM public.rbac_check_permissions(NULL)$$,
  '22023',
  'p_checks must be a JSON array',
  'NULL input is rejected'
);
SELECT throws_ok(
  $$SELECT * FROM public.rbac_check_permissions(
    (SELECT jsonb_agg(jsonb_build_object('permission_key', 'org.read')) FROM generate_series(1, 501))
  )$$,
  '22023',
  'p_checks accepts at most 500 entries',
  'more than 500 entries is rejected'
);
SELECT lives_ok(
  $$SELECT * FROM public.rbac_check_permissions(
    (SELECT jsonb_agg(jsonb_build_object('permission_key', 'org.read')) FROM generate_series(1, 500))
  )$$,
  'exactly 500 entries is accepted'
);

-- Grants and security mode match rbac_check_permission.
SELECT tests.clear_authentication();
SELECT throws_ok(
  $$SELECT * FROM public.rbac_check_permissions('[]'::jsonb)$$,
  '42501',
  NULL,
  'anon cannot execute rbac_check_permissions'
);
SET LOCAL role postgres;
SELECT is(
  has_function_privilege('authenticated', 'public.rbac_check_permissions(jsonb)', 'EXECUTE'),
  has_function_privilege('authenticated', 'public.rbac_check_permission(text, uuid, character varying, bigint)', 'EXECUTE'),
  'authenticated EXECUTE matches rbac_check_permission'
);
SELECT is(
  has_function_privilege('service_role', 'public.rbac_check_permissions(jsonb)', 'EXECUTE'),
  has_function_privilege('service_role', 'public.rbac_check_permission(text, uuid, character varying, bigint)', 'EXECUTE'),
  'service_role EXECUTE matches rbac_check_permission'
);
SELECT is(
  has_function_privilege('anon', 'public.rbac_check_permissions(jsonb)', 'EXECUTE'),
  has_function_privilege('anon', 'public.rbac_check_permission(text, uuid, character varying, bigint)', 'EXECUTE'),
  'anon EXECUTE matches rbac_check_permission'
);
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public.rbac_check_permissions(jsonb)'::regprocedure),
  false,
  'batch is SECURITY INVOKER so it adds no privilege over the single checks'
);
SELECT is(
  (SELECT proconfig FROM pg_proc WHERE oid = 'public.rbac_check_permissions(jsonb)'::regprocedure),
  ARRAY['search_path=""'],
  'batch pins an empty search_path'
);

SELECT * FROM finish();

ROLLBACK;
