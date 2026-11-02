-- The canceled-org retention cron (cleanup_long_canceled_org_data, 03:20 UTC)
-- hit the 120 s statement timeout every day. Each step recomputed the retention
-- state org by org: canceled_org_ids_past_grace() called
-- canceled_org_may_receive_retention_deletion() for every org, which ran the
-- credit exemption check and canceled_org_last_activity_at() (eight activity
-- sources) per org; the warning gate then recomputed the anchor once more per
-- org. One pass took about 23 s in production for ~8,000 canceled orgs and the
-- job makes several passes (alerts x2, versions, apps, audit log batches).
--
-- canceled_org_retention_states() computes access end, retention anchor and
-- credit exemption for every canceled/deleted org in one set-based query with
-- the same predicates as the per-org helpers, and the batch selectors use it.
-- The per-org helpers are unchanged and still re-check each batch under the
-- org row locks before anything is mutated.

CREATE OR REPLACE FUNCTION public.canceled_org_retention_states()
RETURNS TABLE (
    org_id uuid,
    access_end timestamp with time zone,
    anchor_at timestamp with time zone,
    credit_exempt boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH canceled AS MATERIALIZED (
    SELECT
      o.id,
      COALESCE(o.has_usage_credits, false) AS has_usage_credits,
      GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at) AS access_end
    FROM public.orgs AS o
    INNER JOIN public.stripe_info AS si ON si.customer_id = o.customer_id
    WHERE si.status IN ('canceled', 'deleted')
  ),
  -- Same sources and predicates as canceled_org_last_activity_at().
  activity AS (
    SELECT c.id AS org_id, a.created_at AS activity_at
    FROM canceled AS c
    INNER JOIN public.apps AS a ON a.owner_org = c.id
    WHERE a.created_at > c.access_end
    UNION ALL
    SELECT c.id, av.created_at
    FROM canceled AS c
    INNER JOIN public.app_versions AS av ON av.owner_org = c.id
    WHERE av.created_at > c.access_end
    UNION ALL
    SELECT c.id, av.updated_at
    FROM canceled AS c
    INNER JOIN public.app_versions AS av ON av.owner_org = c.id
    WHERE av.deleted = false
      AND av.updated_at > c.access_end
      AND av.updated_at > av.created_at
    UNION ALL
    SELECT c.id, d.updated_at
    FROM canceled AS c
    INNER JOIN public.apps AS a ON a.owner_org = c.id
    INNER JOIN public.devices AS d ON d.app_id = a.app_id
    WHERE d.updated_at > c.access_end
    UNION ALL
    SELECT c.id, (dm.date::timestamp AT TIME ZONE 'UTC')
    FROM canceled AS c
    INNER JOIN public.apps AS a ON a.owner_org = c.id
    INNER JOIN public.daily_mau AS dm ON dm.app_id = a.app_id
    WHERE dm.mau > 0
      AND (dm.date::timestamp AT TIME ZONE 'UTC') > c.access_end
    UNION ALL
    SELECT c.id, g.granted_at
    FROM canceled AS c
    INNER JOIN public.usage_credit_grants AS g ON g.org_id = c.id
    WHERE g.granted_at > c.access_end
    UNION ALL
    SELECT c.id, uc.applied_at
    FROM canceled AS c
    INNER JOIN public.usage_credit_consumptions AS uc ON uc.org_id = c.id
    WHERE uc.applied_at > c.access_end
    UNION ALL
    SELECT c.id, t.occurred_at
    FROM canceled AS c
    INNER JOIN public.usage_credit_transactions AS t ON t.org_id = c.id
    WHERE t.transaction_type <> 'expiry'::public.credit_transaction_type
      AND t.occurred_at > c.access_end
  ),
  last_activity AS (
    SELECT activity.org_id, MAX(activity.activity_at) AS activity_at
    FROM activity
    GROUP BY activity.org_id
  )
  SELECT
    c.id,
    c.access_end,
    -- canceled_org_retention_anchor()
    GREATEST(c.access_end, la.activity_at),
    -- canceled_org_retention_credit_purchase_exempt()
    c.has_usage_credits
    OR EXISTS (
      SELECT 1
      FROM public.usage_credit_grants AS g
      WHERE g.org_id = c.id
        AND g.granted_at >= c.access_end
    )
  FROM canceled AS c
  LEFT JOIN last_activity AS la ON la.org_id = c.id;
$$;

ALTER FUNCTION public.canceled_org_retention_states() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_states() FROM public;
REVOKE ALL ON FUNCTION public.canceled_org_retention_states() FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_states() FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_states() TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_states() IS
'Set-based retention state of every canceled/deleted org: access end, retention anchor '
'(canceled_org_retention_anchor) and credit exemption (canceled_org_retention_credit_purchase_exempt), '
'computed in one pass for the retention batch selectors.';

CREATE OR REPLACE FUNCTION public.canceled_org_ids_past_grace(p_days integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT state.org_id
  FROM public.canceled_org_retention_states() AS state
  WHERE NOT state.credit_exempt
    AND state.anchor_at
      <= pg_catalog.now() - make_interval(days => GREATEST(0, COALESCE(p_days, 0)));
$$;

ALTER FUNCTION public.canceled_org_ids_past_grace(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM public;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(
    integer
) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_ids_past_grace(
    integer
) TO service_role;

COMMENT ON FUNCTION public.canceled_org_ids_past_grace(integer) IS
'Org ids whose stripe_info is canceled/deleted, without active usage credits or a usage credit grant since access end, '
'and whose retention anchor (access end or later activity) is older than p_days. Set-based '
'(canceled_org_retention_states); same result as canceled_org_may_receive_retention_deletion per org.';

CREATE OR REPLACE FUNCTION public.canceled_org_retention_warning_meets_lead_time_at(
    p_org_id uuid,
    p_alert_type text,
    p_anchor_at timestamp with time zone,
    p_lead_days integer DEFAULT 5
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH k AS MATERIALIZED (
    SELECT
      'retention:'
      || p_alert_type
      || ':'
      || to_char(p_anchor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uid,
      CASE
        WHEN p_alert_type = 'bundles_deletion_warning' THEN 'org:bundles_will_be_deleted'
        WHEN p_alert_type = 'app_deletion_warning' THEN 'org:apps_will_be_deleted'
      END AS event,
      pg_catalog.now() - make_interval(days => GREATEST(0, COALESCE(p_lead_days, 5))) AS cutoff
  )
  SELECT
    -- A recipient delivery marker, written only after the email provider
    -- accepted the send (sendNotifOrgOnce recordDelivery).
    EXISTS (
      SELECT 1
      FROM public.notifications AS n
      CROSS JOIN k
      WHERE n.owner_org = p_org_id
        AND n.event = k.event
        AND pg_catalog.starts_with(n.uniq_id, k.uid || ':')
        AND pg_catalog.right(n.uniq_id, 10) = ':delivered'
        AND n.created_at <= k.cutoff
    )
    -- Or the org-level claim, written once every recipient was handled and at
    -- least one send succeeded. It must sit next to recipient claims: the old
    -- no-recipient path wrote the same uniq_id without sending anything.
    OR EXISTS (
      SELECT 1
      FROM public.notifications AS n
      CROSS JOIN k
      WHERE n.owner_org = p_org_id
        AND n.event = k.event
        AND n.uniq_id = k.uid
        AND n.created_at <= k.cutoff
        AND EXISTS (
          SELECT 1
          FROM public.notifications AS r
          WHERE r.owner_org = p_org_id
            AND r.event = k.event
            AND pg_catalog.starts_with(r.uniq_id, k.uid || ':')
            AND r.uniq_id <> k.uid || ':no_recipients'
        )
    );
$$;
ALTER FUNCTION public.canceled_org_retention_warning_meets_lead_time_at(
    uuid, text, timestamp with time zone, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time_at(
    uuid, text, timestamp with time zone, integer
) FROM public;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time_at(
    uuid, text, timestamp with time zone, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time_at(
    uuid, text, timestamp with time zone, integer
) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time_at(
    uuid, text, timestamp with time zone, integer
) TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_warning_meets_lead_time_at(
    uuid, text, timestamp with time zone, integer
) IS
'canceled_org_retention_warning_meets_lead_time for an already computed retention anchor.';

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
  SELECT public.canceled_org_retention_warning_meets_lead_time_at(
    p_org_id,
    p_alert_type,
    public.canceled_org_retention_anchor(p_org_id),
    p_lead_days
  );
$$;
ALTER FUNCTION public.canceled_org_retention_warning_meets_lead_time(
    uuid, text, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(
    uuid, text, integer
) FROM public;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(
    uuid, text, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(
    uuid, text, integer
) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(
    uuid, text, integer
) TO service_role;

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
  c_lead_days CONSTANT integer := 5;
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

  -- No upper bound on age: an org already past day 90/95 that was never warned
  -- still gets its warning, and the cleanup gate waits for it to be delivered.
  FOR org_record IN
    SELECT
      o.id AS org_id,
      o.name AS org_name,
      o.management_email,
      anchor.anchor_at AS access_end,
      cycle.uid,
      COALESCE(
        (
          SELECT jsonb_agg(a.app_id ORDER BY a.app_id)
          FROM public.apps AS a
          WHERE a.owner_org = o.id
        ),
        '[]'::jsonb
      ) AS app_ids
    FROM public.canceled_org_retention_states() AS anchor
    JOIN public.orgs AS o ON o.id = anchor.org_id
    CROSS JOIN LATERAL (
      SELECT
        'retention:'
        || p_alert_type
        || ':'
        || to_char(anchor.anchor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uid
    ) AS cycle
    WHERE NOT anchor.credit_exempt
      AND anchor.anchor_at <= pg_catalog.now() - make_interval(days => v_min_days)
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
          AND (
            n.uniq_id IN (cycle.uid, cycle.uid || ':no_recipients')
            OR (
              pg_catalog.starts_with(n.uniq_id, cycle.uid || ':')
              AND pg_catalog.right(n.uniq_id, 10) = ':delivered'
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pgmq.q_canceled_org_retention_alerts AS q
        WHERE q.message -> 'payload' ->> 'org_id' = o.id::text
          AND q.message -> 'payload' ->> 'alert_type' = p_alert_type
      )
    ORDER BY o.id
    LIMIT v_batch_size
    FOR UPDATE OF o
  LOOP
    IF public.canceled_org_retention_credit_purchase_exempt(org_record.org_id) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.notifications AS n
      WHERE n.owner_org = org_record.org_id
        AND n.event = v_event
        AND (
          n.uniq_id IN (org_record.uid, org_record.uid || ':no_recipients')
          OR (
            pg_catalog.starts_with(n.uniq_id, org_record.uid || ':')
            AND pg_catalog.right(n.uniq_id, 10) = ':delivered'
          )
        )
    ) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pgmq.q_canceled_org_retention_alerts AS q
      WHERE q.message -> 'payload' ->> 'org_id' = org_record.org_id::text
        AND q.message -> 'payload' ->> 'alert_type' = p_alert_type
    ) THEN
      CONTINUE;
    END IF;

    -- Destructive steps wait for the warning to be c_lead_days old, so a
    -- catch-up warning never announces less than that.
    v_days_until := GREATEST(
      c_lead_days,
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
ALTER FUNCTION public.queue_canceled_org_retention_alerts(
    text, integer, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(
    text, integer, integer
) FROM public;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(
    text, integer, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(
    text, integer, integer
) FROM authenticated;
GRANT ALL ON FUNCTION public.queue_canceled_org_retention_alerts(
    text, integer, integer
) TO service_role;

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
  v_batch_org_ids uuid[];
  unlinked_count bigint := 0;
  deleted_count bigint := 0;
BEGIN
  PERFORM set_config('capgo.seed_channel_targets', 'true', true);

  -- Evaluate the warning gate once per org, before picking version rows, so
  -- orgs that are not warned yet cannot fill the batch.
  WITH gated_orgs AS MATERIALIZED (
    SELECT state.org_id AS id
    FROM public.canceled_org_retention_states() AS state
    WHERE NOT state.credit_exempt
      AND state.anchor_at <= pg_catalog.now() - make_interval(days => 90)
      AND public.canceled_org_retention_warning_meets_lead_time_at(
        state.org_id,
        'bundles_deletion_warning',
        state.anchor_at,
        5
      )
  )
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT batch.owner_org), '{}'::uuid[])
  INTO v_batch_org_ids
  FROM (
    SELECT av.owner_org
    FROM public.app_versions AS av
    INNER JOIN gated_orgs AS g ON g.id = av.owner_org
    WHERE av.deleted = false
      AND av.name NOT IN ('builtin', 'unknown')
    ORDER BY av.id
    LIMIT v_batch_size
  ) AS batch;

  IF pg_catalog.cardinality(v_batch_org_ids) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM 1
  FROM public.orgs AS o
  WHERE o.id = ANY (v_batch_org_ids)
  ORDER BY o.id
  FOR UPDATE;

  -- Re-check under the org locks (credit purchases lock the same rows).
  SELECT COALESCE(pg_catalog.array_agg(batch_org.id ORDER BY batch_org.id), '{}'::uuid[])
  INTO v_batch_org_ids
  FROM pg_catalog.unnest(v_batch_org_ids) AS batch_org(id)
  WHERE public.canceled_org_may_receive_retention_deletion(batch_org.id, 90)
    AND public.canceled_org_retention_warning_meets_lead_time(
      batch_org.id,
      'bundles_deletion_warning',
      5
    );

  IF pg_catalog.cardinality(v_batch_org_ids) = 0 THEN
    RETURN 0;
  END IF;

  WITH eligible AS (
    SELECT av.id, av.app_id
    FROM public.app_versions AS av
    WHERE av.deleted = false
      AND av.name NOT IN ('builtin', 'unknown')
      AND av.owner_org = ANY (v_batch_org_ids)
    ORDER BY av.id
    LIMIT v_batch_size
  ),
  cleared AS (
    UPDATE public.channels AS c
    SET
      version = CASE
        WHEN EXISTS (SELECT 1 FROM eligible AS x WHERE x.id = c.version) THEN NULL
        ELSE c.version
      END,
      rollout_version = CASE
        WHEN EXISTS (SELECT 1 FROM eligible AS x WHERE x.id = c.rollout_version) THEN NULL
        ELSE c.rollout_version
      END,
      updated_at = pg_catalog.now()
    WHERE c.app_id IN (SELECT DISTINCT x.app_id FROM eligible AS x)
      AND EXISTS (
        SELECT 1
        FROM eligible AS x
        WHERE x.id = c.version OR x.id = c.rollout_version
      )
    RETURNING c.id
  ),
  soft_deleted AS (
    UPDATE public.app_versions AS av
    SET deleted = true
    FROM eligible
    WHERE av.id = eligible.id
      AND NOT public.canceled_org_retention_credit_purchase_exempt(av.owner_org)
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
ALTER FUNCTION public.soft_delete_versions_for_long_canceled_orgs(
    integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(
    integer
) FROM public;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(
    integer
) FROM anon;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(
    integer
) FROM authenticated;
GRANT ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(
    integer
) TO service_role;

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
  v_batch_org_ids uuid[];
  deleted_count bigint := 0;
BEGIN
  WITH gated_orgs AS MATERIALIZED (
    SELECT state.org_id AS id
    FROM public.canceled_org_retention_states() AS state
    WHERE NOT state.credit_exempt
      AND state.anchor_at <= pg_catalog.now() - make_interval(days => 95)
      AND public.canceled_org_retention_warning_meets_lead_time_at(
        state.org_id,
        'app_deletion_warning',
        state.anchor_at,
        5
      )
  )
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT batch.owner_org), '{}'::uuid[])
  INTO v_batch_org_ids
  FROM (
    SELECT a.owner_org
    FROM public.apps AS a
    INNER JOIN gated_orgs AS g ON g.id = a.owner_org
    ORDER BY a.app_id
    LIMIT v_batch_size
  ) AS batch;

  IF pg_catalog.cardinality(v_batch_org_ids) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM 1
  FROM public.orgs AS o
  WHERE o.id = ANY (v_batch_org_ids)
  ORDER BY o.id
  FOR UPDATE;

  SELECT COALESCE(pg_catalog.array_agg(batch_org.id ORDER BY batch_org.id), '{}'::uuid[])
  INTO v_batch_org_ids
  FROM pg_catalog.unnest(v_batch_org_ids) AS batch_org(id)
  WHERE public.canceled_org_may_receive_retention_deletion(batch_org.id, 95)
    AND public.canceled_org_retention_warning_meets_lead_time(
      batch_org.id,
      'app_deletion_warning',
      5
    );

  IF pg_catalog.cardinality(v_batch_org_ids) = 0 THEN
    RETURN 0;
  END IF;

  WITH eligible AS (
    SELECT
      a.app_id,
      a.owner_org,
      a.user_id,
      a.created_at AS app_created_at,
      COALESCE(u.email::text, o.management_email) AS email
    FROM public.apps AS a
    JOIN public.orgs AS o ON o.id = a.owner_org
    LEFT JOIN public.users AS u ON u.id = a.user_id
    WHERE a.owner_org = ANY (v_batch_org_ids)
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
    FROM eligible AS c
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
    USING eligible AS c
    WHERE a.app_id = c.app_id
      AND a.owner_org = c.owner_org
      AND NOT public.canceled_org_retention_credit_purchase_exempt(a.owner_org)
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
ALTER FUNCTION public.delete_apps_for_long_canceled_orgs(
    integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(
    integer
) FROM public;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(
    integer
) FROM anon;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(
    integer
) FROM authenticated;
GRANT ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(
    integer
) TO service_role;
