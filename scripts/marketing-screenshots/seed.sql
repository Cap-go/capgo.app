-- Fake demo data for marketing screenshots. LOCAL STACK ONLY: it rewrites the
-- seed.sql demo app (com.demo.app) in place. Safe to run more than once.
-- Triggers are skipped (session_replication_role = replica) because the bundle
-- guards refuse to rename uploaded seed bundles.
begin;
set local session_replication_role = replica;

update public.users set first_name = 'Demo', last_name = 'User', discord_username = 'demo', github_username = 'demo' where email = 'test@capgo.app';
update public.users set first_name = 'Maya', last_name = 'Chen' where email = 'test2@capgo.app';
update public.users set first_name = 'Jordan', last_name = 'Lee' where email = 'admin@capgo.app';

-- Versions: reuse seed rows so FKs stay valid.
update app_versions set name = v.name, r2_path = 'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.demo.app/' || v.name || '.zip',
  created_at = now() - v.age, comment = v.comment, manifest_count = 214, storage_provider = 'r2', checksum = v.checksum,
  native_packages = v.pkgs
from (values
  (3, '4.7.2', interval '29 days', 'Faster cold start on Android', 'a91c04f7', array[
    '{"name":"@capacitor/core","version":"8.0.1"}','{"name":"@capacitor/camera","version":"8.0.2"}','{"name":"@capgo/capacitor-updater","version":"8.41.0"}','{"name":"@capacitor/push-notifications","version":"8.0.0"}','{"name":"@capgo/capacitor-social-login","version":"8.3.0"}']::jsonb[]),
  (4, '4.7.3', interval '18 days', 'Checkout copy fixes', '5d2a3b19', array[
    '{"name":"@capacitor/core","version":"8.0.1"}','{"name":"@capacitor/camera","version":"8.0.2"}','{"name":"@capgo/capacitor-updater","version":"8.41.0"}','{"name":"@capacitor/push-notifications","version":"8.0.0"}','{"name":"@capgo/capacitor-social-login","version":"8.3.0"}']::jsonb[]),
  (7, '4.8.0', interval '6 days', 'New cart and saved items', '9f74e70a', array[
    '{"name":"@capacitor/core","version":"8.0.2"}','{"name":"@capacitor/camera","version":"8.0.2"}','{"name":"@capgo/capacitor-updater","version":"8.42.3"}','{"name":"@capacitor/push-notifications","version":"8.0.0"}','{"name":"@capgo/capacitor-social-login","version":"8.3.0"}']::jsonb[]),
  (6, '4.8.1', interval '3 days', 'Fix cart crash on Android 15', '44913a9f', array[
    '{"name":"@capacitor/core","version":"8.0.2"}','{"name":"@capacitor/camera","version":"8.0.2"}','{"name":"@capgo/capacitor-updater","version":"8.42.3"}','{"name":"@capacitor/push-notifications","version":"8.0.0"}','{"name":"@capgo/capacitor-social-login","version":"8.3.0"}']::jsonb[]),
  (5, '4.8.2-beta.1', interval '1 day', 'Apple sign-in and camera upgrade', '3885ee49', array[
    '{"name":"@capacitor/core","version":"8.0.2"}','{"name":"@capacitor/camera","version":"8.1.0"}','{"name":"@capgo/capacitor-updater","version":"8.42.3"}','{"name":"@capacitor/push-notifications","version":"8.0.0"}','{"name":"@capgo/capacitor-social-login","version":"8.4.2"}','{"name":"@capacitor/haptics","version":"8.0.0"}']::jsonb[])
) as v(id, name, age, comment, checksum, pkgs)
where app_versions.id = v.id;

update app_versions_meta set size = s.size, checksum = s.checksum
from (values (3, 4180000, 'a91c04f7'), (4, 4192000, '5d2a3b19'), (7, 4380000, '9f74e70a'), (6, 4376000, '44913a9f'), (5, 4512000, '3885ee49')) as s(id, size, checksum)
where app_versions_meta.id = s.id;

update apps set allow_preview = true where app_id = 'com.demo.app';

-- Channels.
update channels set name = 'staging', public = false, ios = true, android = true, version = 6 where id = 3;
update channels set name = 'production', public = true, ios = true, android = true, version = 7,
  rollout_version = 6, rollout_enabled = true, rollout_percentage_bps = 2500, rollout_paused_at = null,
  auto_pause_enabled = true, auto_pause_window_minutes = 30, auto_pause_failure_rate_bps = 300,
  auto_pause_confidence = 0.95, auto_pause_min_attempts = 200, auto_pause_min_failures = 20, auto_pause_action = 'pause'
where id = 1;
update channels set name = 'beta', public = false, ios = true, android = true, version = 5, allow_device_self_set = true where id = 2;
update channels set name = 'electron', public = false, electron = true, version = 6 where id = 5;

-- Native builds over the last 30 days.
delete from build_logs where app_id = 'com.demo.app' and build_id like 'job-demo-%';
delete from build_requests where app_id = 'com.demo.app' and builder_job_id like 'job-demo-%';
insert into build_requests (app_id, owner_org, requested_by, platform, build_mode, status, builder_job_id, upload_session_key, upload_path, upload_url, upload_expires_at, last_error, created_at, started_at, completed_at, runner_wait_seconds)
select 'com.demo.app', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', b.platform, 'release', b.status,
  'job-demo-' || b.n, 'demo-session-' || b.n, 'builds/demo-' || b.n || '.zip', 'https://example.com/upload/' || b.n, now() + interval '1 day',
  b.err, now() - b.age, now() - b.age + interval '40 seconds', case when b.status in ('succeeded', 'failed') then now() - b.age + (b.secs || ' seconds')::interval end, 12
from (values
  (1, 'ios', 'succeeded', interval '28 days', 612, null), (2, 'android', 'succeeded', interval '28 days 1 hour', 388, null),
  (3, 'ios', 'failed', interval '24 days', 141, 'Provisioning profile does not include the Push Notifications capability'),
  (4, 'ios', 'succeeded', interval '23 days', 598, null), (5, 'android', 'succeeded', interval '19 days', 402, null),
  (6, 'ios', 'succeeded', interval '15 days', 655, null), (7, 'android', 'succeeded', interval '15 days 2 hours', 371, null),
  (8, 'android', 'failed', interval '11 days', 96, 'Gradle: SDK location not found for flavor "staging"'),
  (9, 'android', 'succeeded', interval '10 days', 395, null), (10, 'ios', 'succeeded', interval '7 days', 631, null),
  (11, 'android', 'succeeded', interval '7 days 1 hour', 384, null), (12, 'ios', 'succeeded', interval '4 days', 604, null),
  (13, 'android', 'succeeded', interval '2 days', 362, null), (14, 'ios', 'succeeded', interval '1 day', 588, null),
  (15, 'android', 'succeeded', interval '20 hours', 379, null), (16, 'ios', 'running', interval '6 minutes', 0, null)
) as b(n, platform, status, age, secs, err);

insert into build_logs (created_at, org_id, user_id, build_id, platform, billable_seconds, build_time_unit, app_id)
select br.completed_at, br.owner_org, br.requested_by, br.builder_job_id, br.platform,
  extract(epoch from br.completed_at - br.started_at)::bigint, extract(epoch from br.completed_at - br.started_at)::bigint, br.app_id
from build_requests br where br.app_id = 'com.demo.app' and br.builder_job_id like 'job-demo-%' and br.completed_at is not null;

-- Organization security posture.
-- 2FA and password policy are patched in API responses instead (mocks.ts):
-- enforcing them here would lock the seed account out of the login flow.
update orgs set enforce_hashed_api_keys = true where id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

commit;
