-- Single-flight cleanup of soft-deleted versions.
--
-- on_version_update cleanup passes could run for one version from several
-- queue messages at once (the sweeper re-touched versions whose earlier
-- messages were still retrying), all fighting over the same manifest rows and
-- timing out. A pass now holds a short lease per version; duplicate messages
-- acknowledge without working.
CREATE TABLE "public"."version_cleanup_leases" (
    "app_version_id" bigint NOT NULL,
    "owner" uuid NOT NULL,
    "lease_until" timestamp with time zone NOT NULL,
    CONSTRAINT "version_cleanup_leases_pkey" PRIMARY KEY ("app_version_id"),
    CONSTRAINT "version_cleanup_leases_app_version_id_fkey"
        FOREIGN KEY ("app_version_id") REFERENCES "public"."app_versions" ("id") ON DELETE CASCADE
);

ALTER TABLE "public"."version_cleanup_leases" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."version_cleanup_leases" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."version_cleanup_leases" FROM "anon";
REVOKE ALL ON TABLE "public"."version_cleanup_leases" FROM "authenticated";
GRANT ALL ON TABLE "public"."version_cleanup_leases" TO "service_role";

-- Backend connections, table owners, and service_role bypass RLS; PostgREST
-- callers must not access rows directly.
CREATE POLICY "Deny all direct access"
ON "public"."version_cleanup_leases"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

-- The sweeper now:
-- * skips versions under an active cleanup lease or touched in the last 30
--   minutes (a message for them is already queued or running), instead of
--   adding a duplicate message every 15 minutes, and leaves the counter of a
--   leased version to the running pass;
-- * also re-queues deletes left unfinished in the last 30 days (bundle size
--   never cleared), since the re-queued pass now runs the full delete;
-- * touches updated_at only: any app_versions update enqueues
--   on_version_update, so it no longer inflates manifest_count, which made the
--   final cleanup decrement apps.manifest_bundle_count for versions that were
--   never counted.
CREATE OR REPLACE FUNCTION "public"."sweep_deleted_version_manifests"("p_batch_size" integer DEFAULT 100)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
      -- A running pass clears the counter itself once its last batch is
      -- done; clearing it here too would decrement the app count twice.
      AND NOT EXISTS (
        SELECT 1
        FROM public.version_cleanup_leases AS lease
        WHERE lease.app_version_id = av.id
          AND lease.lease_until > now()
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

  -- Re-queue deleted versions with leftover manifest rows or an unfinished
  -- bundle cleanup by touching them.
  WITH candidates AS (
    SELECT av.id
    FROM public.app_versions AS av
    WHERE av.deleted = true
      AND av.updated_at < now() - interval '30 minutes'
      AND (
        EXISTS (
          SELECT 1
          FROM public.manifest AS m
          WHERE m.app_version_id = av.id
        )
        OR (
          av.deleted_at > now() - interval '30 days'
          AND EXISTS (
            SELECT 1
            FROM public.app_versions_meta AS meta
            WHERE meta.id = av.id
              AND meta.size > 0
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.version_cleanup_leases AS lease
        WHERE lease.app_version_id = av.id
          AND lease.lease_until > now()
      )
    ORDER BY av.deleted_at NULLS LAST, av.id
    LIMIT p_batch_size
  )
  UPDATE public.app_versions AS av
  SET updated_at = now()
  FROM candidates
  WHERE av.id = candidates.id;

  GET DIAGNOSTICS requeued = ROW_COUNT;

  IF stale_fixed > 0 OR requeued > 0 THEN
    RAISE NOTICE 'sweep_deleted_version_manifests: stale_counters=% requeued=%', stale_fixed, requeued;
  END IF;

  RETURN requeued;
END;
$$;

ALTER FUNCTION "public"."sweep_deleted_version_manifests"(integer) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."sweep_deleted_version_manifests"(integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sweep_deleted_version_manifests"(integer) TO "service_role";

COMMENT ON FUNCTION "public"."sweep_deleted_version_manifests"(integer) IS
  'Bounded sweeper for soft-deleted versions with leftover manifest rows, unfinished bundle cleanup (last 30 days), or stale manifest_count. Touches rows so on_version_update finishes the delete; skips versions under a cleanup lease or touched in the last 30 minutes.';
