-- Soft-delete app versions for orgs that have been canceled (or Stripe-deleted)
-- for more than 90 days past period end / cancel / trial end.
-- Also mark never-converted expired trials as canceled so they enter the same path.

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
-- delete_old_deleted_versions for storage cleanup and hard delete.
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
  'Soft-delete app versions for orgs canceled/deleted more than 90 days',
  'function',
  'public.soft_delete_versions_for_long_canceled_orgs()',
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
