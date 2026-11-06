-- Orgs that bought usage credits after their subscription ended are paying
-- customers, even when the balance is used up (orgs.has_usage_credits false).
-- Retention must not warn them or delete their bundles and apps. Destructive
-- steps lock the org row, re-check exemption immediately before mutating data,
-- and credit top-ups lock the same org row so purchases serialize with cleanup.

CREATE OR REPLACE FUNCTION public.canceled_org_retention_credit_purchase_exempt(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    COALESCE(o.has_usage_credits, false)
    OR EXISTS (
      SELECT 1
      FROM public.usage_credit_grants AS g
      JOIN public.stripe_info AS si ON si.customer_id = o.customer_id
      WHERE g.org_id = o.id
        AND si.status IN ('canceled', 'deleted')
        AND g.granted_at >= GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
    )
  FROM public.orgs AS o
  WHERE o.id = p_org_id;
$$;

ALTER FUNCTION public.canceled_org_retention_credit_purchase_exempt(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_retention_credit_purchase_exempt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_retention_credit_purchase_exempt(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_retention_credit_purchase_exempt(uuid) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_retention_credit_purchase_exempt(uuid) TO service_role;

COMMENT ON FUNCTION public.canceled_org_retention_credit_purchase_exempt(uuid) IS
  'True when a canceled/deleted org must skip retention warnings and destructive cleanup because it has active usage credits or bought credits after access ended.';

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
      AND GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
        <= pg_catalog.now() - make_interval(days => GREATEST(0, COALESCE(p_days, 0)))
  );
$$;

ALTER FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.canceled_org_may_receive_retention_deletion(uuid, integer) IS
  'True when a canceled/deleted org is past p_days since access end and is not exempt from retention (credits or post-access credit purchase).';

CREATE OR REPLACE FUNCTION public.canceled_org_ids_past_grace(p_days integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id
  FROM public.orgs AS o
  WHERE public.canceled_org_may_receive_retention_deletion(o.id, p_days);
$$;

ALTER FUNCTION public.canceled_org_ids_past_grace(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) TO service_role;

COMMENT ON FUNCTION public.canceled_org_ids_past_grace(integer) IS
  'Org ids whose stripe_info is canceled/deleted, without active usage credits or a usage credit grant since access end, '
  'and GREATEST(canceled_at, subscription_anchor_end, trial_at) is older than p_days.';

COMMENT ON FUNCTION public.long_canceled_org_ids() IS
  'Org ids past 90-day canceled grace without active usage credits or '
  'credit purchases since access end (see canceled_org_ids_past_grace).';

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
  v_max_days integer := v_min_days + 5;
  v_event text;
  v_queued bigint := 0;
  org_record RECORD;
  v_days_until integer;
BEGIN
  IF p_alert_type = 'bundles_deletion_warning' THEN
    v_event := 'org:bundles_will_be_deleted';
  ELSIF p_alert_type = 'app_deletion_warning' THEN
    v_event := 'org:apps_will_be_deleted';
  ELSE
    RAISE EXCEPTION 'unsupported retention alert type: %', p_alert_type;
  END IF;

  FOR org_record IN
    SELECT
      o.id AS org_id,
      o.name AS org_name,
      o.management_email,
      GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at) AS access_end,
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
      AND NOT public.canceled_org_retention_credit_purchase_exempt(o.id)
      AND GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
        <= pg_catalog.now() - make_interval(days => v_min_days)
      AND GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
        > pg_catalog.now() - make_interval(days => v_max_days)
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
          AND n.uniq_id = (
            'retention:'
            || p_alert_type
            || ':'
            || to_char(
              GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS"Z"'
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
        AND n.uniq_id = (
          'retention:'
          || p_alert_type
          || ':'
          || to_char(
            org_record.access_end AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
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

    v_days_until := GREATEST(
      0,
      CEIL(
        EXTRACT(
          EPOCH FROM (
            org_record.access_end
            + make_interval(days => v_max_days)
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
      'queue_canceled_org_retention_alerts: type=% queued=% window=[%,%)',
      p_alert_type,
      v_queued,
      v_min_days,
      v_max_days;
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
  'Queues once-per-cancel-cycle Bento/tracking warnings for canceled orgs '
  'without active usage credits or credit purchases since access end in [p_min_days, p_min_days+5). Bundles require '
  'a deletable app_versions row; apps require an apps row. Dedup uniq_id uses '
  'access_end UTC timestamp.';

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

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT batch.owner_org), '{}'::uuid[])
  INTO v_batch_org_ids
  FROM (
    SELECT av.owner_org
    FROM public.app_versions AS av
    INNER JOIN (
      SELECT public.canceled_org_ids_past_grace(90) AS id
    ) AS eligible_orgs ON eligible_orgs.id = av.owner_org
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

  WITH eligible AS (
    SELECT av.id, av.app_id
    FROM public.app_versions AS av
    WHERE av.deleted = false
      AND av.name NOT IN ('builtin', 'unknown')
      AND av.owner_org = ANY (v_batch_org_ids)
      AND public.canceled_org_may_receive_retention_deletion(av.owner_org, 90)
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
  'Soft-deletes app_versions for orgs past the 90-day canceled grace window (see long_canceled_org_ids). Unlinks only channel targets pointing at deletion candidates. Bounded by p_batch_size.';

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
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT batch.owner_org), '{}'::uuid[])
  INTO v_batch_org_ids
  FROM (
    SELECT a.owner_org
    FROM public.apps AS a
    INNER JOIN (
      SELECT public.canceled_org_ids_past_grace(95) AS id
    ) AS eligible_orgs ON eligible_orgs.id = a.owner_org
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
      AND public.canceled_org_may_receive_retention_deletion(a.owner_org, 95)
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
  'Deletes apps for orgs past the 95-day canceled grace window after archiving app_id + creator email into old_apps. Bounded by p_batch_size.';

CREATE OR REPLACE FUNCTION public.top_up_usage_credits(
  p_org_id uuid,
  p_amount numeric,
  p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_source text DEFAULT 'manual'::text,
  p_source_ref jsonb DEFAULT NULL::jsonb,
  p_notes text DEFAULT NULL::text
)
RETURNS TABLE(
  grant_id uuid,
  transaction_id bigint,
  available_credits numeric,
  total_credits numeric,
  next_expiration timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_empty CONSTANT text := '';
  c_service_role CONSTANT text := 'service_role';
  c_default_source CONSTANT text := 'manual';
  c_purchase CONSTANT public.credit_transaction_type := 'purchase'::public.credit_transaction_type;
  c_session_id_key CONSTANT text := 'sessionId';
  c_payment_intent_key CONSTANT text := 'paymentIntentId';
  v_request_role text := current_setting('request.jwt.claim.role', true);
  v_effective_expires timestamptz := COALESCE(p_expires_at, now() + interval '1 year');
  v_source_ref jsonb := p_source_ref;
  v_session_id text := NULLIF(v_source_ref ->> c_session_id_key, c_empty);
  v_payment_intent_id text := NULLIF(v_source_ref ->> c_payment_intent_key, c_empty);
  v_grant_id uuid;
  v_transaction_id bigint;
  v_available numeric := 0;
  v_total numeric := 0;
  v_next_expiration timestamptz;
  v_existing_transaction_id bigint;
  v_existing_grant_id uuid;
BEGIN
  IF current_user <> 'postgres' AND COALESCE(v_request_role, c_empty) <> c_service_role THEN
    RAISE EXCEPTION 'insufficient_privileges';
  END IF;

  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive';
  END IF;

  -- Serialize with canceled-org retention cleanup on the same org row.
  PERFORM 1
  FROM public.orgs AS o
  WHERE o.id = p_org_id
  FOR UPDATE;

  -- Guard the grant/transaction creation inside a subtransaction so we can detect
  -- race-condition duplicates via the new unique indexes and return the existing
  -- ledger row instead of creating another grant.
  BEGIN
    INSERT INTO public.usage_credit_grants (
      org_id,
      credits_total,
      credits_consumed,
      granted_at,
      expires_at,
      source,
      source_ref,
      notes
    )
    VALUES (
      p_org_id,
      p_amount,
      0,
      now(),
      v_effective_expires,
      COALESCE(NULLIF(p_source, c_empty), c_default_source),
      v_source_ref,
      p_notes
    )
    RETURNING id INTO v_grant_id;

    SELECT
      COALESCE(b.total_credits, 0),
      COALESCE(b.available_credits, 0),
      b.next_expiration
    INTO v_total, v_available, v_next_expiration
    FROM public.usage_credit_balances AS b
    WHERE b.org_id = p_org_id;

    INSERT INTO public.usage_credit_transactions (
      org_id,
      grant_id,
      transaction_type,
      amount,
      balance_after,
      description,
      source_ref
    )
    VALUES (
      p_org_id,
      v_grant_id,
      c_purchase,
      p_amount,
      v_available,
      p_notes,
      v_source_ref
    )
    RETURNING id INTO v_transaction_id;

  EXCEPTION WHEN unique_violation THEN
    IF v_session_id IS NULL AND v_payment_intent_id IS NULL THEN
      RAISE;
    END IF;

    SELECT t.id, t.grant_id
    INTO v_existing_transaction_id, v_existing_grant_id
    FROM public.usage_credit_transactions AS t
    WHERE t.org_id = p_org_id
      AND t.transaction_type = c_purchase
      AND (
        (v_session_id IS NOT NULL AND t.source_ref ->> c_session_id_key = v_session_id)
        OR (v_payment_intent_id IS NOT NULL AND t.source_ref ->> c_payment_intent_key = v_payment_intent_id)
      )
    ORDER BY t.id DESC
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE;
    END IF;

    SELECT
      COALESCE(b.total_credits, 0),
      COALESCE(b.available_credits, 0),
      b.next_expiration
    INTO v_total, v_available, v_next_expiration
    FROM public.usage_credit_balances AS b
    WHERE b.org_id = p_org_id;

    v_grant_id := v_existing_grant_id;
    v_transaction_id := v_existing_transaction_id;
  END;

  grant_id := v_grant_id;
  transaction_id := v_transaction_id;
  available_credits := v_available;
  total_credits := v_total;
  next_expiration := v_next_expiration;

  RETURN NEXT;
  RETURN;
END;
$$;

ALTER FUNCTION public.top_up_usage_credits(uuid, numeric, timestamp with time zone, text, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.top_up_usage_credits(uuid, numeric, timestamp with time zone, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.top_up_usage_credits(uuid, numeric, timestamp with time zone, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.top_up_usage_credits(uuid, numeric, timestamp with time zone, text, jsonb, text) FROM authenticated;
GRANT ALL ON FUNCTION public.top_up_usage_credits(uuid, numeric, timestamp with time zone, text, jsonb, text) TO service_role;
