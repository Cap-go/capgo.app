BEGIN;


SELECT plan(7);

CREATE OR REPLACE FUNCTION app_metrics_cache_tests() RETURNS SETOF TEXT AS $$
DECLARE
  test_org uuid := '046a36ac-e03c-4590-9257-bd6c9dba9ee8';
  test_app character varying := 'com.demo.app';
  test_start date := DATE '2024-01-01';
  test_end date := DATE '2024-01-01';
  initial_mau bigint;
  cached_mau bigint;
  refreshed_mau bigint;
  cache_time_1 timestamp with time zone;
  cache_time_2 timestamp with time zone;
  cache_time_3 timestamp with time zone;
  nonexistent_count bigint;
BEGIN
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  -- Reset relevant tables to provide a clean slate for cache assertions
  TRUNCATE TABLE public.app_metrics_cache;
  TRUNCATE TABLE public.daily_mau;
  TRUNCATE TABLE public.daily_storage_hourly;
  TRUNCATE TABLE public.daily_bandwidth;
  TRUNCATE TABLE public.daily_version;

  INSERT INTO public.daily_mau (app_id, date, mau) VALUES (test_app, test_start, 5);
  INSERT INTO public.daily_bandwidth (app_id, date, bandwidth) VALUES (test_app, test_start, 0);
  INSERT INTO public.daily_storage_hourly (app_id, owner_org, date, storage_byte_hours) VALUES (test_app, test_org, test_start, 0);

  SELECT COALESCE(SUM(mau), 0)
  INTO initial_mau
  FROM public.get_app_metrics(test_org, test_start, test_end);

  SELECT cached_at
  INTO cache_time_1
  FROM public.app_metrics_cache
  WHERE org_id = test_org;

  UPDATE public.daily_mau
  SET mau = 10
  WHERE app_id = test_app AND date = test_start;

  SELECT COALESCE(SUM(mau), 0)
  INTO cached_mau
  FROM public.get_app_metrics(test_org, test_start, test_end);

  SELECT cached_at
  INTO cache_time_2
  FROM public.app_metrics_cache
  WHERE org_id = test_org;

  UPDATE public.app_metrics_cache
  SET cached_at = cached_at - INTERVAL '6 minutes'
  WHERE org_id = test_org;

  UPDATE public.daily_mau
  SET mau = 20
  WHERE app_id = test_app AND date = test_start;

  SELECT COALESCE(SUM(mau), 0)
  INTO refreshed_mau
  FROM public.get_app_metrics(test_org, test_start, test_end);

  SELECT cached_at
  INTO cache_time_3
  FROM public.app_metrics_cache
  WHERE org_id = test_org;

  SELECT COUNT(*)
  INTO nonexistent_count
  FROM public.get_app_metrics('00000000-0000-0000-0000-000000000000', test_start, test_end);

  RETURN NEXT is(initial_mau, 5::bigint, 'Initial fetch seeds cache with current metrics');
  RETURN NEXT ok(cache_time_1 IS NOT NULL, 'Cache row created on first fetch');
  RETURN NEXT is(cached_mau, 5::bigint, 'Repeated fetch within 5 minutes reuses cached data');
  RETURN NEXT ok(cache_time_2 = cache_time_1, 'Cache timestamp unchanged when cache reused');
  RETURN NEXT is(refreshed_mau, 20::bigint, 'Cache refreshes after timeout and captures changes');
  RETURN NEXT ok(cache_time_3 > cache_time_2, 'Cache timestamp advances after refresh');
  RETURN NEXT is(nonexistent_count, 0::bigint, 'Non-existent org returns no rows');
END;
$$ LANGUAGE plpgsql;

SELECT app_metrics_cache_tests();

SELECT *
FROM
    finish();

ROLLBACK;
