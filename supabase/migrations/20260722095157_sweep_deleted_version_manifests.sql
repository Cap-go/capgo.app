-- Sweep soft-deleted app_versions

CREATE INDEX IF NOT EXISTS idx_app_versions_deleted_with_manifest
  ON public.app_versions (id)
  WHERE deleted = true AND manifest_count > 0;

CREATE INDEX IF NOT EXISTS idx_app_versions_deleted_at_id
  ON public.app_versions (deleted_at, id)
  WHERE deleted = true;

-- Sweeps soft-deleted app_versions that still have manifest rows or stale counters.
-- Touches a bounded batch so on_version_update re-runs cleanup_manifest.
-- Also zeros stale manifest_count when no rows remain.

CREATE OR REPLACE FUNCTION "public"."sweep_deleted_version_manifests"("p_batch_size" integer DEFAULT 100)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  stale_fixed bigint := 0;
  requeued bigint := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN
    p_batch_size := 100;
  END IF;

  -- Fix stale counters: deleted versions with manifest_count > 0 but no rows.
  WITH stale AS (
    SELECT av.id, av.app_id
    FROM public.app_versions AS av
    WHERE av.deleted = true
      AND av.manifest_count > 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.manifest AS m
        WHERE m.app_version_id = av.id
      )
    ORDER BY av.deleted_at NULLS LAST, av.id
    LIMIT p_batch_size
  ),
  cleared AS (
    UPDATE public.app_versions AS av
    SET manifest_count = 0,
        manifest = NULL,
        updated_at = now()
    FROM stale
    WHERE av.id = stale.id
    RETURNING stale.app_id
  ),
  app_counts AS (
    SELECT app_id, COUNT(*)::int AS cleared_count
    FROM cleared
    GROUP BY app_id
  )
  UPDATE public.apps AS a
  SET manifest_bundle_count = GREATEST(a.manifest_bundle_count - app_counts.cleared_count, 0),
      updated_at = now()
  FROM app_counts
  WHERE a.app_id = app_counts.app_id;

  GET DIAGNOSTICS stale_fixed = ROW_COUNT;

  -- Re-queue deleted versions that still have manifest rows by touching them.
  -- on_version_update trigger enqueues cleanup when deleted_at is unchanged and
  -- manifest_count > 0.
  -- Start from deleted versions (bounded) and probe manifest via app_version_id index.
  WITH candidates AS (
    SELECT av.id
    FROM public.app_versions AS av
    WHERE av.deleted = true
      AND EXISTS (
        SELECT 1
        FROM public.manifest AS m
        WHERE m.app_version_id = av.id
      )
    ORDER BY av.deleted_at NULLS LAST, av.id
    LIMIT p_batch_size
  )
  UPDATE public.app_versions AS av
  SET manifest_count = GREATEST(av.manifest_count, 1),
      updated_at = now()
  FROM candidates
  WHERE av.id = candidates.id;

  GET DIAGNOSTICS requeued = ROW_COUNT;

  IF stale_fixed > 0 OR requeued > 0 THEN
    RAISE NOTICE 'sweep_deleted_version_manifests: stale_counters=% requeued=%', stale_fixed, requeued;
  END IF;

  RETURN requeued;
END;
$$;

ALTER FUNCTION public.sweep_deleted_version_manifests(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sweep_deleted_version_manifests(integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sweep_deleted_version_manifests(integer) TO service_role;

COMMENT ON FUNCTION public.sweep_deleted_version_manifests(integer) IS
  'Bounded sweeper for soft-deleted versions with leftover manifest rows or stale manifest_count. Re-touches rows so on_version_update runs cleanup_manifest (DB delete + R2 trash).';

INSERT INTO public.cron_tasks (
  name,
  description,
  task_type,
  target,
  batch_size,
  payload,
  second_interval,
  minute_interval,
  hour_interval,
  run_at_hour,
  run_at_minute,
  run_at_second,
  run_on_dow,
  run_on_day,
  enabled,
  healthcheck_url
) VALUES (
  'sweep_deleted_version_manifests',
  'Re-queue soft-deleted versions that still have manifest rows; zero stale manifest_count',
  'function',
  'public.sweep_deleted_version_manifests(100)',
  NULL,
  NULL,
  NULL,
  15,
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  NULL,
  true,
  NULL
)
ON CONFLICT (name) DO UPDATE
SET
  description = EXCLUDED.description,
  task_type = EXCLUDED.task_type,
  target = EXCLUDED.target,
  minute_interval = EXCLUDED.minute_interval,
  enabled = EXCLUDED.enabled,
  updated_at = now();
