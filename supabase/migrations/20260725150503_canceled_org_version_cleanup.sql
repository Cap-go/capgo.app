-- Soft-delete app versions and purge audit_logs for orgs that have been
-- canceled (or Stripe-deleted) for more than 90 days past period end / cancel /
-- trial end. Also mark never-converted expired trials as canceled so they enter
-- the same path.
--
-- Timeout safety: version soft-delete is limited by p_batch_size; audit delete
-- uses ctid batches + max_runtime_ms (same pattern as cleanup_old_audit_logs).
-- Catch-up continues on later cron ticks — no edge/queue fan-out needed.

-- Expired free trials: mark canceled (NULL status never matched "<> succeeded").
CREATE OR REPLACE FUNCTION public.process_free_trial_expired()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stripe_info
  SET
    is_good_plan = false,
    status = 'canceled',
    canceled_at = COALESCE(canceled_at, trial_at)
  WHERE status IS DISTINCT FROM 'succeeded'
    AND status IS DISTINCT FROM 'deleted'
    AND trial_at < NOW();
END;
$$;

ALTER FUNCTION public.process_free_trial_expired() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_free_trial_expired() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_free_trial_expired() FROM anon;
REVOKE ALL ON FUNCTION public.process_free_trial_expired() FROM authenticated;
GRANT ALL ON FUNCTION public.process_free_trial_expired() TO service_role;

COMMENT ON FUNCTION public.process_free_trial_expired() IS
  'Marks expired never-converted trials as canceled (is_good_plan=false, status=canceled, canceled_at=trial_at) so they share the canceled-org retention path.';

-- Soft-delete versions for long-canceled orgs. Reuses on_version_update +
-- delete_old_deleted_versions for storage/manifest cleanup and hard delete.
CREATE OR REPLACE FUNCTION public.soft_delete_versions_for_long_canceled_orgs(
  p_batch_size integer DEFAULT 5000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size integer := GREATEST(1, COALESCE(p_batch_size, 5000));
  unlinked_count bigint := 0;
  deleted_count bigint := 0;
BEGIN
  -- Bypass channel promote guard for this internal cleanup (same gate seed uses).
  PERFORM set_config('capgo.seed_channel_targets', 'true', true);

  -- Eligible when canceled/deleted and paid/trial access ended 90+ days ago.
  -- canceled_at is period end for cancel-at-period-end; for past_due churn it is
  -- set when Stripe finally ends the sub (after retries). Trials use trial_at.
  -- Single WITH: pick a version batch first, unlink only those targets, then soft-delete.
  WITH eligible_orgs AS (
    SELECT o.id AS org_id
    FROM public.stripe_info AS si
    JOIN public.orgs AS o ON o.customer_id = si.customer_id
    WHERE si.status IN ('canceled', 'deleted')
      AND COALESCE(si.canceled_at, si.subscription_anchor_end, si.trial_at)
        <= pg_catalog.now() - INTERVAL '90 days'
  ),
  candidates AS (
    SELECT av.id
    FROM public.app_versions AS av
    JOIN eligible_orgs AS e ON e.org_id = av.owner_org
    WHERE av.deleted = false
      AND av.name NOT IN ('builtin', 'unknown')
    ORDER BY av.id
    LIMIT v_batch_size
  ),
  cleared AS (
    UPDATE public.channels AS c
    SET
      version = CASE
        WHEN EXISTS (SELECT 1 FROM candidates AS x WHERE x.id = c.version) THEN NULL
        ELSE c.version
      END,
      rollout_version = CASE
        WHEN EXISTS (SELECT 1 FROM candidates AS x WHERE x.id = c.rollout_version) THEN NULL
        ELSE c.rollout_version
      END,
      updated_at = pg_catalog.now()
    WHERE EXISTS (
      SELECT 1
      FROM candidates AS x
      WHERE x.id = c.version OR x.id = c.rollout_version
    )
    RETURNING c.id
  ),
  soft_deleted AS (
    UPDATE public.app_versions AS av
    SET deleted = true
    FROM candidates
    WHERE av.id = candidates.id
    RETURNING av.id
  )
  SELECT
    (SELECT COUNT(*) FROM cleared),
    (SELECT COUNT(*) FROM soft_deleted)
  INTO unlinked_count, deleted_count;

  IF unlinked_count > 0 OR deleted_count > 0 THEN
    RAISE NOTICE
      'soft_delete_versions_for_long_canceled_orgs: unlinked_channels=% soft_deleted_versions=%',
      unlinked_count,
      deleted_count;
  END IF;

  RETURN deleted_count;
END;
$$;

ALTER FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) FROM anon;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) FROM authenticated;
GRANT ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) TO service_role;

COMMENT ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) IS
  'Soft-deletes app_versions for orgs canceled/deleted more than 90 days past COALESCE(canceled_at, subscription_anchor_end, trial_at). Unlinks only channel targets pointing at deletion candidates. Bounded by p_batch_size.';

-- Purge audit_logs for long-canceled orgs. Bounded by batch size + runtime budget
-- so a large backlog cannot timeout the daily cron tick.
CREATE OR REPLACE FUNCTION public.cleanup_audit_logs_for_long_canceled_orgs(
  max_batches integer DEFAULT 1000000,
  batch_size integer DEFAULT 1000,
  max_runtime_ms integer DEFAULT 60000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  batch_no integer := 0;
  deleted_batch integer;
  deleted_total bigint := 0;
  v_max_batches integer := GREATEST(1, COALESCE(max_batches, 1000000));
  v_batch_size integer := GREATEST(1, COALESCE(batch_size, 1000));
  v_max_runtime_ms integer := GREATEST(1000, COALESCE(max_runtime_ms, 60000));
  started_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('statement_timeout', '0', true);

  LOOP
    batch_no := batch_no + 1;
    EXIT WHEN batch_no > v_max_batches;
    EXIT WHEN (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000) >= v_max_runtime_ms;

    WITH eligible_orgs AS (
      SELECT o.id AS org_id
      FROM public.stripe_info AS si
      JOIN public.orgs AS o ON o.customer_id = si.customer_id
      WHERE si.status IN ('canceled', 'deleted')
        AND COALESCE(si.canceled_at, si.subscription_anchor_end, si.trial_at)
          <= pg_catalog.now() - INTERVAL '90 days'
    )
    DELETE FROM public.audit_logs AS al
    WHERE al.ctid IN (
      SELECT audit.ctid
      FROM public.audit_logs AS audit
      JOIN eligible_orgs AS e ON e.org_id = audit.org_id
      ORDER BY audit.org_id, audit.created_at, audit.id
      LIMIT v_batch_size
    );

    GET DIAGNOSTICS deleted_batch = ROW_COUNT;
    deleted_total := deleted_total + deleted_batch;
    EXIT WHEN deleted_batch = 0;
  END LOOP;

  IF deleted_total > 0 THEN
    RAISE NOTICE
      'cleanup_audit_logs_for_long_canceled_orgs: deleted=% batches=%/% batch_size=% runtime_ms=% budget_ms=%',
      deleted_total,
      LEAST(batch_no, v_max_batches),
      v_max_batches,
      v_batch_size,
      (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000)::bigint,
      v_max_runtime_ms;
  END IF;

  RETURN deleted_total;
END;
$$;

ALTER FUNCTION public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer) TO service_role;

COMMENT ON FUNCTION public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer) IS
  'Deletes audit_logs for orgs canceled/deleted more than 90 days past COALESCE(canceled_at, subscription_anchor_end, trial_at). Batched with a runtime budget to avoid cron timeouts.';

-- One cron entry: versions first (may write audit rows), then purge org audit logs.
CREATE OR REPLACE FUNCTION public.cleanup_long_canceled_org_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.soft_delete_versions_for_long_canceled_orgs();
  PERFORM public.cleanup_audit_logs_for_long_canceled_orgs();
END;
$$;

ALTER FUNCTION public.cleanup_long_canceled_org_data() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cleanup_long_canceled_org_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_long_canceled_org_data() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_long_canceled_org_data() FROM authenticated;
GRANT ALL ON FUNCTION public.cleanup_long_canceled_org_data() TO service_role;

COMMENT ON FUNCTION public.cleanup_long_canceled_org_data() IS
  'Daily canceled-org retention: soft-delete app versions then purge audit_logs for orgs past the 90-day grace window. Both steps are batch/runtime bounded.';

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
  'canceled_org_version_cleanup',
  'Soft-delete app versions and purge audit logs for orgs canceled/deleted more than 90 days',
  'function',
  'public.cleanup_long_canceled_org_data()',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  3,
  20,
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
  run_at_hour = EXCLUDED.run_at_hour,
  run_at_minute = EXCLUDED.run_at_minute,
  run_at_second = EXCLUDED.run_at_second,
  enabled = EXCLUDED.enabled,
  updated_at = now();
