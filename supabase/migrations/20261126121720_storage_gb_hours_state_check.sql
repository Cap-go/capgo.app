-- Storage GB-hours billing: follow-up to 20261117152120 (capgo.app#4171).
--
-- capgo.app#4190 renamed the prod-applied 20261117152120 to 20261120001201,
-- which blocked `supabase db push` (remote version missing locally). The
-- original file is restored byte for byte and 20261120001201 is removed (it
-- was never applied in prod).
--
-- #4190's delta against 20261117152120 has no schema effect: it wrapped the
-- same statements in BEGIN/COMMIT with 500ms lock_timeout retries on apps,
-- app_versions, daily_storage_hourly, version_meta and daily_storage, and
-- moved two statements into those retry blocks. Every object it creates is
-- created by 20261117152120. Replaying that SQL here would re-run its data
-- backfills, so this migration does not. It only checks, from the catalog,
-- that the end state #4190 targeted is in place. No DDL, no data writes, no
-- table locks: safe and a no-op on any database that has 20261117152120.
DO $capgo_storage_gb_hours_state_check$
DECLARE
  v_fn text;
  v_oid oid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.daily_storage_hourly'::regclass
      AND a.attname = 'cycle_start'
      AND a.attnotnull
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'storage GB-hours: public.daily_storage_hourly.cycle_start missing (20261117152120 not applied)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.version_meta'::regclass
      AND a.attname = 'recorded_at'
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'storage GB-hours: public.version_meta.recorded_at missing (20261117152120 not applied)';
  END IF;

  IF pg_catalog.to_regclass('public.daily_storage_hourly_refreshes') IS NULL THEN
    RAISE EXCEPTION 'storage GB-hours: public.daily_storage_hourly_refreshes missing (20261117152120 not applied)';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.daily_storage_hourly'::regclass
      AND c.conname = 'daily_storage_hourly_app_id_fkey'
  ) THEN
    RAISE EXCEPTION 'storage GB-hours: daily_storage_hourly_app_id_fkey still present (hours of deleted apps would cascade away)';
  END IF;

  IF pg_catalog.to_regclass('public.daily_storage') IS NOT NULL THEN
    RAISE EXCEPTION 'storage GB-hours: legacy public.daily_storage still present';
  END IF;

  -- SECURITY DEFINER trigger functions must stay closed to client roles.
  FOREACH v_fn IN ARRAY ARRAY[
    'close_app_storage_lifetimes',
    'guard_apps_ownership_history',
    'open_restored_version_storage_lifetime'
  ] LOOP
    SELECT p.oid INTO v_oid
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_fn
      AND p.prosecdef;
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'storage GB-hours: SECURITY DEFINER public.%() missing', v_fn;
    END IF;
    IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'storage GB-hours: public.%() is executable by anon or authenticated', v_fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.apps'::regclass AND t.tgname = 'guard_apps_ownership_history'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.apps'::regclass AND t.tgname = 'close_app_storage_lifetimes'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.app_versions'::regclass AND t.tgname = 'open_restored_version_storage_lifetime'
  ) THEN
    RAISE EXCEPTION 'storage GB-hours: apps/app_versions lifetime triggers missing';
  END IF;
END;
$capgo_storage_gb_hours_state_check$;
