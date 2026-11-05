-- Canceled-org retention: start the retention clock from the latest org
-- activity after paid access ended, queue catch-up warnings without the old
-- 5-day window, and require a delivered warning at least 5 days old before the
-- 90-day bundle soft-delete or the 95-day app removal.
--
-- Builds on 20261023001537_exempt_credit_buyers_from_canceled_retention: orgs
-- with usage credits or a credit purchase since access end stay fully exempt,
-- destructive steps still lock the org rows and re-check right before mutating.

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
  'Stripe-derived end of paid access for a canceled/deleted org: GREATEST(canceled_at, subscription_anchor_end, trial_at).';

CREATE OR REPLACE FUNCTION public.canceled_org_last_activity_at(p_org_id uuid)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH billing AS MATERIALIZED (
    SELECT public.canceled_org_billing_access_end(p_org_id) AS access_end
  )
  SELECT MAX(activity_rows.activity_at)
  FROM (
    SELECT a.created_at AS activity_at
    FROM public.apps AS a
    CROSS JOIN billing AS b
    WHERE a.owner_org = p_org_id
      AND a.created_at > b.access_end
    UNION ALL
    SELECT av.created_at
    FROM public.app_versions AS av
    CROSS JOIN billing AS b
    WHERE av.owner_org = p_org_id
      AND av.created_at > b.access_end
    UNION ALL
    -- Writes to existing bundles (manifest/finalize). Soft-deleted rows are
    -- skipped so the retention soft-delete itself never counts as activity.
    SELECT av.updated_at
    FROM public.app_versions AS av
    CROSS JOIN billing AS b
    WHERE av.owner_org = p_org_id
      AND av.deleted = false
      AND av.updated_at > b.access_end
      AND av.updated_at > av.created_at
    UNION ALL
    SELECT d.updated_at
    FROM public.devices AS d
    INNER JOIN public.apps AS a ON a.app_id = d.app_id
    CROSS JOIN billing AS b
    WHERE a.owner_org = p_org_id
      AND d.updated_at > b.access_end
    UNION ALL
    SELECT (dm.date::timestamp AT TIME ZONE 'UTC')
    FROM public.daily_mau AS dm
    INNER JOIN public.apps AS a ON a.app_id = dm.app_id
    CROSS JOIN billing AS b
    WHERE a.owner_org = p_org_id
      AND dm.mau > 0
      AND (dm.date::timestamp AT TIME ZONE 'UTC') > b.access_end
    UNION ALL
    SELECT g.granted_at
    FROM public.usage_credit_grants AS g
    CROSS JOIN billing AS b
    WHERE g.org_id = p_org_id
      AND g.granted_at > b.access_end
    UNION ALL
    SELECT uc.applied_at
    FROM public.usage_credit_consumptions AS uc
    CROSS JOIN billing AS b
    WHERE uc.org_id = p_org_id
      AND uc.applied_at > b.access_end
    UNION ALL
    -- Credit expiry is system-generated, not org activity.
    SELECT t.occurred_at
    FROM public.usage_credit_transactions AS t
    CROSS JOIN billing AS b
    WHERE t.org_id = p_org_id
      AND t.transaction_type <> 'expiry'::public.credit_transaction_type
      AND t.occurred_at > b.access_end
  ) AS activity_rows;
$$;

ALTER FUNCTION public.canceled_org_last_activity_at(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_last_activity_at(uuid) TO service_role;

COMMENT ON FUNCTION public.canceled_org_last_activity_at(uuid) IS
  'Latest org activity after paid access ended: app/bundle creation, writes to live bundles, device updates, '
  'MAU, usage-credit grants, consumption and non-expiry transactions. NULL when there is none.';

CREATE OR REPLACE FUNCTION public.canceled_org_retention_anchor(p_org_id uuid)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH billing AS MATERIALIZED (
    SELECT public.canceled_org_billing_access_end(p_org_id) AS access_end
  )
  SELECT GREATEST(b.access_end, public.canceled_org_last_activity_at(p_org_id))
  FROM billing AS b;
$$;

ALTER FUNCTION public.canceled_org_retention_anchor(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_anchor(uuid) TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_anchor(uuid) IS
  'Retention clock start for a canceled/deleted org: GREATEST(billing access end, last org activity). NULL when not canceled.';

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
  'Once-per-retention-cycle notifications uniq_id for a canceled-org warning (same format as the canceled_org_retention_alerts trigger).';

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
  WITH k AS MATERIALIZED (
    SELECT
      public.canceled_org_retention_uniq_id(p_org_id, p_alert_type) AS uid,
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

ALTER FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_warning_meets_lead_time(uuid, text, integer) IS
  'True when this org''s current retention-cycle warning was delivered at least p_lead_days ago: a recipient '
  ':delivered marker, or the org-level claim backed by recipient claims. No-recipient claims never count.';

CREATE OR REPLACE FUNCTION public.canceled_org_may_receive_retention_deletion(
  p_org_id uuid,
  p_days integer
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.orgs AS o
    JOIN public.stripe_info AS si ON si.customer_id = o.customer_id
    WHERE o.id = p_org_id
      AND si.status IN ('canceled', 'deleted')
      AND NOT public.canceled_org_retention_credit_purchase_exempt(o.id)
      AND public.canceled_org_retention_anchor(o.id)
        <= pg_catalog.now() - make_interval(days => GREATEST(0, COALESCE(p_days, 0)))
  );
$$;

ALTER FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) IS
  'True when a canceled/deleted org is past p_days since its retention anchor (access end or later activity) '
  'and is not exempt from retention (credits or post-access credit purchase).';

COMMENT ON FUNCTION public.canceled_org_ids_past_grace(integer) IS
  'Org ids whose stripe_info is canceled/deleted, without active usage credits or a usage credit grant since access end, '
  'and whose retention anchor (access end or later activity) is older than p_days.';

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
    FROM public.stripe_info AS si
    JOIN public.orgs AS o ON o.customer_id = si.customer_id
    CROSS JOIN LATERAL (
      SELECT public.canceled_org_retention_anchor(o.id) AS anchor_at
    ) AS anchor
    CROSS JOIN LATERAL (
      SELECT
        'retention:'
        || p_alert_type
        || ':'
        || to_char(anchor.anchor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS uid
    ) AS cycle
    WHERE si.status IN ('canceled', 'deleted')
      AND NOT public.canceled_org_retention_credit_purchase_exempt(o.id)
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

ALTER FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) IS
  'Queues once-per-retention-cycle Bento/tracking warnings for canceled orgs without active usage credits or credit '
  'purchases since access end, at or past p_min_days since the retention anchor (no upper bound, so late orgs catch up). '
  'Bundles require a deletable app_versions row; apps require an apps row. Dedup uses the org-level claim, the '
  'no-recipient claim or a recipient delivery marker for the anchor-based uniq_id, plus pending queue messages.';

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
    SELECT past.id
    FROM public.canceled_org_ids_past_grace(90) AS past(id)
    WHERE public.canceled_org_retention_warning_meets_lead_time(
      past.id,
      'bundles_deletion_warning',
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

ALTER FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) FROM anon;
REVOKE ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) FROM authenticated;
GRANT ALL ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) TO service_role;

COMMENT ON FUNCTION public.soft_delete_versions_for_long_canceled_orgs(integer) IS
  'Soft-deletes app_versions for orgs past 90 days since the retention anchor whose bundles_deletion_warning was '
  'delivered at least 5 days ago. Unlinks only channel targets pointing at deletion candidates. Bounded by p_batch_size.';

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
    SELECT past.id
    FROM public.canceled_org_ids_past_grace(95) AS past(id)
    WHERE public.canceled_org_retention_warning_meets_lead_time(
      past.id,
      'app_deletion_warning',
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

ALTER FUNCTION public.delete_apps_for_long_canceled_orgs(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) FROM anon;
REVOKE ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) FROM authenticated;
GRANT ALL ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) TO service_role;

COMMENT ON FUNCTION public.delete_apps_for_long_canceled_orgs(integer) IS
  'Deletes apps for orgs past 95 days since the retention anchor whose app_deletion_warning was delivered at least '
  '5 days ago, after archiving app_id + creator email into old_apps. Bounded by p_batch_size.';

COMMENT ON FUNCTION public.cleanup_long_canceled_org_data() IS
  'Daily canceled-org retention, counted from the retention anchor (access end or later activity): 85d bundle warning, '
  '90d soft-delete versions + app warning, 95d delete apps into old_apps, then purge audit_logs. Deletions also wait '
  'for a delivered warning at least 5 days old. Steps are batch/runtime bounded.';
