BEGIN;
SELECT plan(37);
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'on', true);
SELECT pg_catalog.set_config('capgo.updates_cache_wake_sent', 'on', true);
SELECT is((SELECT count(*)::int FROM pg_policies
  WHERE schemaname='public'
    AND tablename IN ('serving_policy_sync_pending','serving_policy_sync_failed','serving_policy_sync_progress')
    AND permissive='RESTRICTIVE' AND cmd='ALL' AND roles=ARRAY['public']::name[]
    AND qual='false' AND with_check='false'),3,'policy queue tables explicitly deny all direct access');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM (VALUES ('anon'),('authenticated'),('service_role')) roles(role_name)
  CROSS JOIN (VALUES ('serving_policy_sync_pending'),('serving_policy_sync_failed'),('serving_policy_sync_progress')) tables(table_name)
  WHERE has_table_privilege(roles.role_name,'public.'||tables.table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
),'policy RPC callers retain no direct queue-table privileges');
INSERT INTO private.settings(name,value) VALUES ('CAPGO_PLUGIN_STATE_SYNC_ENABLED','false')
ON CONFLICT(name) DO UPDATE SET value = EXCLUDED.value;
DELETE FROM private.settings WHERE name IN ('CAPGO_SERVING_REGIONS_READER_EPOCH','CAPGO_SERVING_REGIONS_ACTIVE_EPOCH');
DELETE FROM public.serving_policy_sync_pending;
DELETE FROM public.serving_policy_sync_failed;
CREATE TEMP TABLE payload_before AS SELECT to_jsonb(s) AS value FROM public.plugin_state_sync_state s;
CREATE TEMP TABLE apps_before AS SELECT to_jsonb(s) AS value FROM public.plugin_state_sync_apps s;
CREATE TEMP TABLE pending_before AS SELECT to_jsonb(s) AS value FROM public.plugin_state_sync_pending s;
INSERT INTO public.apps(app_id, name, icon_url, owner_org)
SELECT 'com.example.policy-recovery.' || lpad(n::text, 5, '0'), 'Policy recovery fixture', '', a.owner_org
FROM generate_series(1,5500) n CROSS JOIN (SELECT owner_org FROM public.apps WHERE app_id='com.demo.app') a;
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_pending),5500,'app inserts queue policy work with payload writer disabled');
DELETE FROM public.serving_policy_sync_pending;
UPDATE public.serving_policy_sync_progress SET epoch='', after_app=NULL, done_at=NULL;
SELECT public.plugin_state_sync_tick();
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_pending),100,'existing periodic tick bootstraps only 100 policies per pass');
CREATE TEMP TABLE first_cursor AS SELECT after_app FROM public.serving_policy_sync_progress;
CREATE TEMP TABLE bootstrap_seen AS SELECT app_id FROM public.serving_policy_sync_pending;
DELETE FROM public.serving_policy_sync_pending;
SELECT public.plugin_state_sync_tick();
SELECT ok((SELECT p.after_app > f.after_app FROM public.serving_policy_sync_progress p CROSS JOIN first_cursor f),'bootstrap resumes after its durable cursor');
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_pending),100,'second bootstrap pass stays bounded');
DO $$
BEGIN
  FOR pass IN 1..100 LOOP
    INSERT INTO bootstrap_seen SELECT app_id FROM public.serving_policy_sync_pending;
    DELETE FROM public.serving_policy_sync_pending;
    PERFORM public.plugin_state_sync_tick();
    EXIT WHEN EXISTS (SELECT 1 FROM public.serving_policy_sync_progress WHERE done_at IS NOT NULL);
  END LOOP;
END;
$$;
SELECT is((SELECT count(*)::int FROM bootstrap_seen),(SELECT count(*)::int FROM public.apps),'bounded bootstrap eventually covers every app, including more than 5392');
SELECT is((SELECT count(DISTINCT app_id)::int FROM bootstrap_seen),(SELECT count(*)::int FROM bootstrap_seen),'resumed pages do not repeat app keys');
SELECT ok(EXISTS(SELECT 1 FROM public.serving_policy_sync_progress WHERE done_at IS NOT NULL),'bootstrap commits completion independently of payload coverage');
SELECT results_eq('SELECT to_jsonb(s) FROM public.plugin_state_sync_state s','SELECT value FROM payload_before','policy tick preserves payload backfill and GC metadata');
SELECT results_eq('SELECT to_jsonb(s) FROM public.plugin_state_sync_apps s ORDER BY app_id','SELECT value FROM apps_before ORDER BY value->>''app_id''','policy tick never claims full/app coverage');
SELECT results_eq('SELECT to_jsonb(s) FROM public.plugin_state_sync_pending s ORDER BY id','SELECT value FROM pending_before ORDER BY (value->>''id'')::bigint','policy bootstrap does not enqueue payload work');
-- Synchronous dispatch failures must not roll back a saved app's durable policy work.
CREATE TEMP SEQUENCE policy_wake_failures;
CREATE TEMP TABLE original_policy_wake AS
SELECT pg_get_functiondef('public.wake_plugin_state_sync()'::regprocedure) AS definition;
CREATE OR REPLACE FUNCTION public.wake_plugin_state_sync() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.nextval('pg_temp.policy_wake_failures');
  RAISE EXCEPTION 'Injected policy wake failure';
END;
$$;
DELETE FROM public.serving_policy_sync_pending;
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'off', true);
INSERT INTO public.apps(app_id, name, icon_url, owner_org)
SELECT 'com.example.policy-wake-failure', 'Policy wake fixture', '', owner_org
FROM public.apps WHERE app_id='com.example.policy-recovery.00001';
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_pending
  WHERE app_id='com.example.policy-wake-failure'),1,'app insert retains durable policy work when its wake fails');
SELECT is((SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int FROM pg_temp.policy_wake_failures),1,'insert attempted the throwing wake');
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'off', true);
UPDATE public.apps SET serving_regions=ARRAY['EU']::text[], serving_region_mode='block'
WHERE app_id='com.example.policy-recovery.00001';
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_pending
  WHERE app_id='com.example.policy-recovery.00001'),1,'saved restriction retains durable policy work after completed bootstrap and wake failure');
SELECT is((SELECT serving_region_mode FROM public.apps
  WHERE app_id='com.example.policy-recovery.00001'),'block','the requested restriction remains saved');
SELECT is((SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int FROM pg_temp.policy_wake_failures),2,'policy update attempted the throwing wake');
DO $$ BEGIN EXECUTE (SELECT definition FROM original_policy_wake); END; $$;
SELECT public.plugin_state_sync_tick();
SELECT is((SELECT count(*)::int FROM public.claim_serving_policy_sync()),1,'periodic recovery can claim policy work after the wake recovers');
DELETE FROM public.serving_policy_sync_pending;
UPDATE public.serving_policy_sync_progress SET done_at=now();
INSERT INTO public.serving_policy_sync_pending(app_id) VALUES('com.example.policy-recovery.00001');
CREATE TEMP TABLE policy_claim AS SELECT * FROM public.claim_serving_policy_sync();
SELECT is((SELECT attempts FROM public.serving_policy_sync_pending),1,'first claim consumes one attempt');
SELECT public.ack_serving_policy_sync((SELECT token FROM policy_claim),false);
SELECT ok((SELECT token IS NULL AND due_at > now() FROM public.serving_policy_sync_pending),'failed publication durably releases with cooldown');
-- Lost HTTP wake and crashed drain: tick must leave work recoverable without the payload switch.
UPDATE public.serving_policy_sync_pending SET due_at=now()-interval '1 second';
SELECT public.plugin_state_sync_tick();
DELETE FROM policy_claim;
INSERT INTO policy_claim SELECT * FROM public.claim_serving_policy_sync();
SELECT is((SELECT attempts FROM public.serving_policy_sync_pending),2,'periodic recovery claims the durable retry with payload disabled');
UPDATE public.serving_policy_sync_pending SET leased_until=now()-interval '1 second', attempts=5;
SELECT public.plugin_state_sync_tick();
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_pending),0,'crashed fifth lease is removed before a sixth claim');
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_failed),1,'fifth failure is archived durably');
SELECT is((SELECT count(*)::int FROM public.claim_serving_policy_sync()),0,'no sixth attempt');
SELECT is(public.repair_serving_policy_sync(1),1,'explicit bounded recovery requeues an archived policy only');
SELECT public.ack_serving_policy_sync((SELECT token FROM public.claim_serving_policy_sync()),true);
SELECT is((SELECT count(*)::int FROM public.serving_policy_sync_pending),0,'successful policy ACK deletes only leased policy work');
SELECT throws_ok($$SELECT public.activate_serving_policy_publication('test-epoch', '{}'::jsonb)$$,'P0001',NULL,'activation refuses missing ingress/readiness prerequisites');
SELECT ok(NOT has_function_privilege('service_role','public.activate_serving_policy_publication(text,jsonb)','EXECUTE'),'ordinary publisher cannot acknowledge deployment activation');
-- Count attempted dispatches without network I/O; sequences also survive failed wake subtransactions.
CREATE TEMP SEQUENCE policy_review_wake_calls;
CREATE OR REPLACE FUNCTION public.wake_plugin_state_sync() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.nextval('pg_temp.policy_review_wake_calls');
END;
$$;
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'off', true);
UPDATE public.apps SET name=name WHERE app_id='com.example.policy-recovery.00001';
SELECT is((SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int FROM pg_temp.policy_review_wake_calls),0,'unrelated app updates add no policy wake');
SELECT setval('pg_temp.policy_review_wake_calls',1,false);
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'off', true);
INSERT INTO public.apps(app_id,name,icon_url,owner_org)
SELECT app_id,name,icon_url,owner_org FROM public.apps WHERE false;
SELECT is((SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int FROM pg_temp.policy_review_wake_calls),0,'empty app inserts add no policy wake');
SELECT setval('pg_temp.policy_review_wake_calls',1,false);
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'off', true);
DELETE FROM public.apps WHERE app_id='com.example.policy-review-missing';
SELECT is((SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int FROM pg_temp.policy_review_wake_calls),0,'empty app deletes add no policy wake');
SELECT setval('pg_temp.policy_review_wake_calls',1,false);
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'on', true);
UPDATE public.apps SET serving_region_mode='route' WHERE app_id='com.example.policy-recovery.00001';
SELECT is((SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int FROM pg_temp.policy_review_wake_calls),0,'policy changes honor an earlier transaction wake');
INSERT INTO private.settings(name,value) VALUES ('CAPGO_PLUGIN_STATE_SYNC_ENABLED','true')
ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;
SELECT setval('pg_temp.policy_review_wake_calls',1,false);
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'off', true);
UPDATE public.apps SET serving_region_mode='block' WHERE app_id='com.example.policy-recovery.00001';
SELECT is((SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int FROM pg_temp.policy_review_wake_calls),1,'policy and payload changes share one transaction wake');
-- A policy epoch transition must fail closed without preventing existing payload maintenance.
INSERT INTO private.settings(name,value) VALUES
  ('CAPGO_SERVING_REGIONS_ACTIVE_EPOCH','active-old-epoch'),
  ('CAPGO_SERVING_REGIONS_READER_EPOCH','reader-new-epoch')
ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value;
SELECT throws_ok($$SELECT * FROM public.claim_serving_policy_sync()$$,'P0001',NULL,'mismatched policy epochs remain fail closed');
SELECT is((SELECT max(attempts) FROM public.serving_policy_sync_pending),0,'failed policy claim retains its attempt and lease state');
DELETE FROM public.plugin_state_sync_pending;
DELETE FROM public.plugin_state_sync_failed WHERE app_id='com.example.policy-recovery.00001';
INSERT INTO public.plugin_state_sync_pending(app_id,kind,ref,attempts)
VALUES('com.example.policy-recovery.00001','app','',5);
SELECT lives_ok($$SELECT public.plugin_state_sync_tick()$$,'policy configuration failure does not abort the payload tick');
SELECT ok(EXISTS(SELECT 1 FROM public.plugin_state_sync_failed WHERE app_id='com.example.policy-recovery.00001' AND kind='app')
  AND NOT EXISTS(SELECT 1 FROM public.plugin_state_sync_pending WHERE app_id='com.example.policy-recovery.00001' AND kind='app'),
  'payload tick still archives its exhausted job during a policy configuration failure');
SELECT * FROM finish();
ROLLBACK;
