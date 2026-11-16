BEGIN;
SELECT plan(20);
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'on', true);
SELECT pg_catalog.set_config('capgo.updates_cache_wake_sent', 'on', true);
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
SELECT * FROM finish();
ROLLBACK;
