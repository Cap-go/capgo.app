-- Canceled-org retention: extend grace from org activity, widen warning catch-up,
-- and require recorded warnings before destructive steps.

CREATE OR REPLACE FUNCTION public.canceled_org_billing_access_end(p_org_id uuid)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
  FROM public.orgs AS o
  INNER JOIN public.stripe_info AS si ON si.customer_id = o.customer_id
  WHERE o.id = p_org_id
    AND si.status IN ('canceled', 'deleted');
$$;

ALTER FUNCTION public.canceled_org_billing_access_end(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_billing_access_end(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_billing_access_end(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_billing_access_end(uuid) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_billing_access_end(uuid) TO service_role;

COMMENT ON FUNCTION public.canceled_org_billing_access_end(uuid) IS
  'Stripe-derived end-of-paid-access timestamp for a canceled/deleted org (GREATEST of canceled_at, subscription_anchor_end, trial_at).';

CREATE OR REPLACE FUNCTION public.canceled_org_last_activity_at(p_org_id uuid)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT GREATEST(
    COALESCE(
      (SELECT MAX(a.created_at) FROM public.apps AS a WHERE a.owner_org = p_org_id),
      '-infinity'::timestamp with time zone
    ),
    COALESCE(
      (
        SELECT MAX(av.created_at)
        FROM public.app_versions AS av
        WHERE av.owner_org = p_org_id
      ),
      '-infinity'::timestamp with time zone
    ),
    COALESCE(
      (
        SELECT MAX(d.updated_at)
        FROM public.devices AS d
        INNER JOIN public.apps AS a ON a.app_id = d.app_id
        WHERE a.owner_org = p_org_id
      ),
      '-infinity'::timestamp with time zone
    ),
    COALESCE(
      (
        SELECT MAX((dm.date::timestamp AT TIME ZONE 'UTC'))
        FROM public.daily_mau AS dm
        INNER JOIN public.apps AS a ON a.app_id = dm.app_id
        WHERE a.owner_org = p_org_id
          AND dm.mau > 0
      ),
      '-infinity'::timestamp with time zone
    ),
    COALESCE(
      (
        SELECT MAX(g.granted_at)
        FROM public.usage_credit_grants AS g
        WHERE g.org_id = p_org_id
      ),
      '-infinity'::timestamp with time zone
    ),
    COALESCE(
      (
        SELECT MAX(c.applied_at)
        FROM public.usage_credit_consumptions AS c
        WHERE c.org_id = p_org_id
      ),
      '-infinity'::timestamp with time zone
    ),
    COALESCE(
      (
        SELECT MAX(t.occurred_at)
        FROM public.usage_credit_transactions AS t
        WHERE t.org_id = p_org_id
      ),
      '-infinity'::timestamp with time zone
    )
  );
$$;

ALTER FUNCTION public.canceled_org_last_activity_at(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) TO service_role;

COMMENT ON FUNCTION public.canceled_org_last_activity_at(uuid) IS
  'Latest retention-relevant activity for an org: app/bundle creation, device updates, MAU, and usage-credit grants/consumption/transactions.';

CREATE OR REPLACE FUNCTION public.canceled_org_retention_anchor(p_org_id uuid)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT GREATEST(
    public.canceled_org_billing_access_end(p_org_id),
    public.canceled_org_last_activity_at(p_org_id)
  );
$$;

ALTER FUNCTION public.canceled_org_retention_anchor(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_anchor(uuid) IS
  'Retention clock start: GREATEST(billing access end, last org activity). Extends grace when canceled orgs stay active.';

CREATE OR REPLACE FUNCTION public.canceled_org_retention_uniq_id(
  p_org_id uuid,
  p_alert_type text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    'retention:'
    || p_alert_type
    || ':'
    || to_char(
      public.canceled_org_retention_anchor(p_org_id) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    );
$$;

ALTER FUNCTION public.canceled_org_retention_uniq_id(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_uniq_id(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_retention_uniq_id(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_uniq_id(uuid, text) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_uniq_id(uuid, text) TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_uniq_id(uuid, text) IS
  'Once-per-retention-cycle uniq_id for canceled-org warning notifications (matches edge trigger formatting).';

CREATE OR REPLACE FUNCTION public.canceled_org_retention_warning_meets_lead_time(
  p_org_id uuid,
  p_alert_type text,
  p_lead_days integer DEFAULT 5
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.notifications AS n
    WHERE n.owner_org = p_org_id
      AND n.event = CASE
        WHEN p_alert_type = 'bundles_deletion_warning' THEN 'org:bundles_will_be_deleted'
        WHEN p_alert_type = 'app_deletion_warning' THEN 'org:apps_will_be_deleted'
        ELSE NULL::character varying
      END
      AND n.uniq_id = public.canceled_org_retention_uniq_id(p_org_id, p_alert_type)
      AND n.created_at <= pg_catalog.now() - make_interval(days => GREATEST(0, COALESCE(p_lead_days, 5)))
  );
$$;

ALTER FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) IS
  'True when the retention warning for this org/alert cycle is recorded in notifications at least p_lead_days ago.';

CREATE OR REPLACE FUNCTION public.canceled_org_ids_past_grace(p_days integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id
  FROM public.stripe_info AS si
  JOIN public.orgs AS o ON o.customer_id = si.customer_id
  WHERE si.status IN ('canceled', 'deleted')
    AND NOT COALESCE(o.has_usage_credits, false)
    AND public.canceled_org_retention_anchor(o.id)
      <= pg_catalog.now() - make_interval(days => GREATEST(0, COALESCE(p_days, 0)));
$$;

ALTER FUNCTION public.canceled_org_ids_past_grace(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) TO service_role;

COMMENT ON FUNCTION public.canceled_org_ids_past_grace(integer) IS
  'Canceled/deleted org ids without active usage credits whose retention anchor (billing end or last activity) is older than p_days.';

CREATE OR REPLACE FUNCTION public.queue_canceled_org_retention_alerts(
  p_alert_type text,
  p_min_days integer,
  p_batch_size integer DEFAULT 500
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size integer := GREATEST(1, COALESCE(p_batch_size, 500));
  v_min_days integer := GREATEST(0, COALESCE(p_min_days, 0));
  v_destructive_days integer;
  v_event text;
  v_queued bigint := 0;
  org_record RECORD;
  v_days_until integer;
BEGIN
  IF p_alert_type = 'bundles_deletion_warning' THEN
    v_event := 'org:bundles_will_be_deleted';
    v_destructive_days := 90;
  ELSIF p_alert_type = 'app_deletion_warning' THEN
    v_event := 'org:apps_will_be_deleted';
    v_destructive_days := 95;
  ELSE
    RAISE EXCEPTION 'unsupported retention alert type: %', p_alert_type;
  END IF;

  FOR org_record IN
    SELECT
      o.id AS org_id,
      o.name AS org_name,
      o.management_email,
      public.canceled_org_retention_anchor(o.id) AS access_end,
      COALESCE(
        (
          SELECT jsonb_agg(a.app_id ORDER BY a.app_id)
          FROM public.apps AS a
          WHERE a.owner_org = o.id
        ),
        '[]'::jsonb
      ) AS app_ids
    FROM public.stripe_info AS si
    JOIN public.orgs AS o ON o.customer_id = si.customer_id
    WHERE si.status IN ('canceled', 'deleted')
      AND NOT COALESCE(o.has_usage_credits, false)
      AND public.canceled_org_retention_anchor(o.id)
        <= pg_catalog.now() - make_interval(days => v_min_days)
      AND (
        CASE
          WHEN p_alert_type = 'bundles_deletion_warning' THEN EXISTS (
            SELECT 1
            FROM public.app_versions AS av
            WHERE av.owner_org = o.id
              AND av.deleted = false
              AND av.name NOT IN ('builtin', 'unknown')
          )
          ELSE EXISTS (
            SELECT 1
            FROM public.apps AS a
            WHERE a.owner_org = o.id
          )
        END
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications AS n
        WHERE n.owner_org = o.id
          AND n.event = v_event
          AND n.uniq_id = public.canceled_org_retention_uniq_id(o.id, p_alert_type)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pgmq.q_canceled_org_retention_alerts AS q
        WHERE q.message -> 'payload' ->> 'org_id' = o.id::text
          AND q.message -> 'payload' ->> 'alert_type' = p_alert_type
      )
    ORDER BY o.id
    LIMIT v_batch_size
  LOOP
    v_days_until := GREATEST(
      0,
      CEIL(
        EXTRACT(
          EPOCH FROM (
            org_record.access_end
            + make_interval(days => v_destructive_days)
            - pg_catalog.now()
          )
        ) / 86400.0
      )::integer
    );

    PERFORM pgmq.send(
      'canceled_org_retention_alerts',
      jsonb_build_object(
        'function_name', 'canceled_org_retention_alerts',
        'function_type', 'cloudflare',
        'payload', jsonb_build_object(
          'org_id', org_record.org_id,
          'org_name', org_record.org_name,
          'management_email', org_record.management_email,
          'alert_type', p_alert_type,
          'access_end', org_record.access_end,
          'days_until_deletion', v_days_until,
          'app_ids', org_record.app_ids
        )
      )
    );
    v_queued := v_queued + 1;
  END LOOP;

  IF v_queued > 0 THEN
    RAISE NOTICE
      'queue_canceled_org_retention_alerts: type=% queued=% min_days=%',
      p_alert_type,
      v_queued,
      v_min_days;
  END IF;

  RETURN v_queued;
END;
$$;

ALTER FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) IS
  'Queues canceled-org retention warnings for orgs at or past p_min_days since the retention anchor, until a notifications claim exists. No narrow 5-day window.';

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
  PERFORM set_config('capgo.seed_channel_targets', 'true', true);

  WITH candidates AS (
    SELECT av.id, av.app_id
    FROM public.app_versions AS av
    WHERE av.owner_org IN (SELECT public.long_canceled_org_ids())
      AND public.canceled_org_retention_warning_meets_lead_time(
        av.owner_org,
        'bundles_deletion_warning',
        5
      )
      AND av.deleted = false
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
    WHERE c.app_id IN (SELECT DISTINCT x.app_id FROM candidates AS x)
      AND EXISTS (
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
  'Soft-deletes app_versions for orgs past the 90-day retention anchor after a recorded bundles_deletion_warning at least 5 days old.';

CREATE OR REPLACE FUNCTION public.delete_apps_for_long_canceled_orgs(
  p_batch_size integer DEFAULT 500
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size integer := GREATEST(1, COALESCE(p_batch_size, 500));
  deleted_count bigint := 0;
BEGIN
  WITH candidates AS (
    SELECT
      a.app_id,
      a.owner_org,
      a.user_id,
      a.created_at AS app_created_at,
      COALESCE(u.email::text, o.management_email) AS email
    FROM public.apps AS a
    JOIN public.orgs AS o ON o.id = a.owner_org
    LEFT JOIN public.users AS u ON u.id = a.user_id
    WHERE a.owner_org IN (SELECT public.canceled_org_ids_past_grace(95))
      AND public.canceled_org_retention_warning_meets_lead_time(
        a.owner_org,
        'app_deletion_warning',
        5
      )
    ORDER BY a.app_id
    LIMIT v_batch_size
  ),
  archived AS (
    INSERT INTO public.old_apps (app_id, email, owner_org, user_id, app_created_at)
    SELECT
      c.app_id,
      c.email,
      c.owner_org,
      c.user_id,
      c.app_created_at
    FROM candidates AS c
    ON CONFLICT (app_id, owner_org) DO UPDATE
    SET
      email = EXCLUDED.email,
      user_id = EXCLUDED.user_id,
      app_created_at = EXCLUDED.app_created_at,
      deleted_at = pg_catalog.now()
    RETURNING old_apps.app_id
  ),
  deleted AS (
    DELETE FROM public.apps AS a
    USING candidates AS c
    WHERE a.app_id = c.app_id
      AND a.owner_org = c.owner_org
    RETURNING a.app_id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;

  IF deleted_count > 0 THEN
    RAISE NOTICE
      'delete_apps_for_long_canceled_orgs: deleted_apps=%',
      deleted_count;
  END IF;

  RETURN deleted_count;
END;
$$;

ALTER FUNCTION public.delete_apps_for_long_canceled_orgs(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) FROM anon;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) FROM authenticated;
GRANT ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) TO service_role;

COMMENT ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) IS
  'Deletes apps for orgs past the 95-day retention anchor after a recorded app_deletion_warning at least 5 days old.';
