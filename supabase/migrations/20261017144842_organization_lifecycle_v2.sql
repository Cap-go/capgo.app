-- Prospectively capture provenance. orgs.created_by can change on transfer;
-- no historical creator is guessed and no existing organization is enrolled.
CREATE TABLE public.org_lifecycle_creators (
  org_id uuid PRIMARY KEY REFERENCES public.orgs(id) ON DELETE CASCADE,
  original_creator_id uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX org_lifecycle_original_creator ON public.org_lifecycle_creators(original_creator_id, org_id);
CREATE TABLE public.bento_lifecycle_journeys (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('ota', 'builder')),
  enrolled_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  selected_app_incarnation uuid,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  support_hold boolean NOT NULL DEFAULT false,
  candidate jsonb,
  revision bigint NOT NULL DEFAULT 0,
  next_evaluation_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  refresh_claim_until timestamptz,
  refresh_claim_token uuid,
  PRIMARY KEY (org_id, product)
);
CREATE INDEX bento_lifecycle_due ON public.bento_lifecycle_journeys(next_evaluation_at, org_id, product);
CREATE TABLE public.bento_lifecycle_app_observations (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('ota', 'builder')),
  app_incarnation uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  acknowledged_before timestamptz,
  seen_facts text[] NOT NULL DEFAULT '{}'::text[],
  verified jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  healthy boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, product, app_incarnation)
);
-- No app FK: history and completion survive app deletion/recreation.
CREATE INDEX bento_lifecycle_dispatch_org ON public.bento_event_dispatches
  ((details->'metadata'->>'orgId'), event_at DESC) WHERE flow_key LIKE 'lifecycle:v2:%';
CREATE INDEX bento_lifecycle_dispatch_person ON public.bento_event_dispatches
  ((details->'metadata'->>'recipientId'), event_at DESC) WHERE flow_key LIKE 'lifecycle:v2:%';

ALTER TABLE public.org_lifecycle_creators OWNER TO postgres;
ALTER TABLE public.bento_lifecycle_journeys OWNER TO postgres;
ALTER TABLE public.bento_lifecycle_app_observations OWNER TO postgres;
ALTER TABLE public.org_lifecycle_creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bento_lifecycle_journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bento_lifecycle_app_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_lifecycle_creators, public.bento_lifecycle_journeys, public.bento_lifecycle_app_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_lifecycle_creators, public.bento_lifecycle_journeys, public.bento_lifecycle_app_observations TO service_role;
CREATE POLICY lifecycle_creators_deny ON public.org_lifecycle_creators AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY lifecycle_journeys_deny ON public.bento_lifecycle_journeys AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY lifecycle_observations_deny ON public.bento_lifecycle_app_observations AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- Pure scalar helpers run only over the one user/app row already being written.
-- No RLS policy calls these helpers and no public/PostgREST role can invoke them.
CREATE FUNCTION public.lifecycle_v2_parse_timestamp(p_value text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
    RETURN NULL;
  END IF;
  RETURN p_value::pg_catalog.timestamptz;
EXCEPTION WHEN data_exception THEN
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.lifecycle_v2_parse_timestamp(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lifecycle_v2_parse_timestamp(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lifecycle_v2_parse_timestamp(text) TO service_role;

CREATE FUNCTION public.lifecycle_v2_user_eligible(p_onboarding jsonb, p_created_at timestamptz, p_created_via_invite boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(
    p_created_via_invite IS FALSE
    AND p_created_at >= '2026-10-17T14:24:00Z'::pg_catalog.timestamptz
    AND pg_catalog.jsonb_typeof(p_onboarding->'abtests_enrolled') = 'array'
    AND (p_onboarding->'abtests_enrolled') ? 'new_emails_v2'
    AND p_onboarding->>'intent' IN ('ota', 'builder')
    AND p_onboarding #>> '{abtests,new_emails_v2,branch}' = 'A'
    AND public.lifecycle_v2_parse_timestamp(p_onboarding #>> '{abtests,new_emails_v2,assigned_at}') >= p_created_at
    AND (p_onboarding->>'intent' <> 'builder' OR (
      p_onboarding #>> '{abtests,builder_todo_list_v4,branch}' = 'A'
      AND public.lifecycle_v2_parse_timestamp(p_onboarding #>> '{abtests,builder_todo_list_v4,assigned_at}') >= p_created_at
    )),
    false
  );
$$;
ALTER FUNCTION public.lifecycle_v2_user_eligible(jsonb, timestamptz, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lifecycle_v2_user_eligible(jsonb, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lifecycle_v2_user_eligible(jsonb, timestamptz, boolean) TO service_role;

-- Mirrors the canonical console checklist, independently checking every flag.
-- An outcome label is not completion; intentional skips establish readiness but
-- are never stored as achievements or independently verified first value.
CREATE FUNCTION public.lifecycle_v2_checklist_complete(p_onboarding jsonb, p_product text, p_created_at timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_setup jsonb := p_onboarding->'setup';
  v_steps jsonb;
  v_ids text[];
  v_id text;
  v_status text;
  v_at timestamptz;
BEGIN
  IF p_created_at IS NULL OR pg_catalog.jsonb_typeof(v_setup) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF p_product = 'ota' AND v_setup->'todo_list_version' = '3'::jsonb THEN
    v_steps := v_setup->'steps';
    v_ids := ARRAY['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'run_device', 'upload_bundle', 'test_update'];
  ELSIF v_setup->'todo_list_version' = '4'::jsonb
    AND pg_catalog.jsonb_typeof(v_setup->'paths') = 'array'
    AND (v_setup->'paths') ? p_product THEN
    IF p_product = 'ota' AND v_setup->'ota_todo_list_version' = '"1"'::jsonb THEN
      v_steps := v_setup #> '{steps,ota}';
      v_ids := ARRAY['login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'run_device', 'upload_bundle', 'test_update'];
    ELSIF p_product = 'builder' AND v_setup->'builder_todo_list_version' = '"1"'::jsonb THEN
      IF v_setup->>'selected_builder_platform' = 'ios' THEN
        v_steps := v_setup #> '{steps,builder,ios}';
        v_ids := ARRAY['start_setup', 'choose_destination', 'connect_app_store', 'prepare_certificate', 'prepare_profile', 'successful_cloud_build'];
      ELSIF v_setup->>'selected_builder_platform' = 'android' THEN
        v_steps := v_setup #> '{steps,builder,android}';
        v_ids := ARRAY['start_setup', 'prepare_keystore', 'connect_google_play', 'successful_cloud_build'];
      END IF;
    END IF;
  END IF;
  IF v_ids IS NULL OR pg_catalog.jsonb_typeof(v_steps) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    v_status := v_steps->v_id->>'status';
    IF v_status IS NULL OR v_status NOT IN ('done', 'skipped') THEN
      RETURN false;
    END IF;
    IF v_status = 'done' AND (v_steps->v_id) ? 'at' THEN
      v_at := public.lifecycle_v2_parse_timestamp(v_steps->v_id->>'at');
      IF v_at IS NULL OR v_at < p_created_at THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
ALTER FUNCTION public.lifecycle_v2_checklist_complete(jsonb, text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lifecycle_v2_checklist_complete(jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lifecycle_v2_checklist_complete(jsonb, text, timestamptz) TO service_role;

CREATE FUNCTION public.preserve_lifecycle_org_creator() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Original lifecycle creator provenance is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.preserve_lifecycle_org_creator() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preserve_lifecycle_org_creator() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preserve_lifecycle_org_creator() TO service_role;
CREATE TRIGGER preserve_lifecycle_org_creator BEFORE UPDATE ON public.org_lifecycle_creators
FOR EACH ROW EXECUTE FUNCTION public.preserve_lifecycle_org_creator();

-- One indexed insert per new org. The private provenance table is never exposed
-- by RPC and has no user foreign key that could erase the original identity.
CREATE FUNCTION public.capture_lifecycle_org_creator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.org_lifecycle_creators(org_id, original_creator_id)
  VALUES (NEW.id, NEW.created_by) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.capture_lifecycle_org_creator() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.capture_lifecycle_org_creator() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_lifecycle_org_creator() TO service_role;
CREATE TRIGGER capture_lifecycle_org_creator AFTER INSERT ON public.orgs
FOR EACH ROW EXECUTE FUNCTION public.capture_lifecycle_org_creator();

-- Only new journey insertion uses this helper. The owner-org index bounds the
-- app lookup, the observation PK proves prospective incarnation capture, and
-- LIMIT 2 detects ambiguity without collecting an entire app list. Selecting
-- this existing context does not add a fact or mark progress/checklist success.
CREATE FUNCTION public.lifecycle_v2_initial_app(p_org_id uuid, p_product text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN pg_catalog.count(*) = 1 THEN (pg_catalog.array_agg(candidate.id))[1] ELSE NULL END
  FROM (
    SELECT a.id FROM public.apps a
    JOIN public.bento_lifecycle_app_observations obs
      ON obs.org_id = a.owner_org AND obs.product = p_product AND obs.app_incarnation = a.id
    WHERE a.owner_org = p_org_id
      AND (
        (p_product = 'ota' AND a.onboarding #> '{setup,todo_list_version}' = '3'::jsonb)
        OR (
          a.onboarding #> '{setup,todo_list_version}' = '4'::jsonb
          AND pg_catalog.jsonb_typeof(a.onboarding #> '{setup,paths}') = 'array'
          AND (a.onboarding #> '{setup,paths}') ? p_product
          AND (a.onboarding #>> '{setup,selected_path}' = p_product
            OR (a.onboarding #> '{setup,paths}') = pg_catalog.jsonb_build_array(p_product))
          AND ((p_product = 'ota' AND a.onboarding #> '{setup,ota_todo_list_version}' = '"1"'::jsonb)
            OR (p_product = 'builder' AND a.onboarding #> '{setup,builder_todo_list_version}' = '"1"'::jsonb))
        )
      )
    LIMIT 2
  ) candidate;
$$;
ALTER FUNCTION public.lifecycle_v2_initial_app(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lifecycle_v2_initial_app(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lifecycle_v2_initial_app(uuid, text) TO service_role;

-- Once per org write. Caller-scoped PK lookups only; no RBAC or large-table scan.
CREATE FUNCTION public.enroll_lifecycle_org_products() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.org_lifecycle_creators c JOIN public.users u ON u.id = c.original_creator_id
    WHERE c.org_id = NEW.id AND public.lifecycle_v2_user_eligible(u.onboarding, u.created_at, u.created_via_invite)) THEN
    FOREACH p IN ARRAY ARRAY['ota', 'builder'] LOOP
      IF NEW.onboarding->>'intent' IN (p, 'both') THEN
        INSERT INTO public.bento_lifecycle_journeys(org_id, product, selected_app_incarnation)
          VALUES (NEW.id, p, public.lifecycle_v2_initial_app(NEW.id, p)) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  UPDATE public.bento_lifecycle_journeys SET next_evaluation_at = pg_catalog.now(),
    revision = revision + 1, candidate = NULL WHERE org_id = NEW.id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enroll_lifecycle_org_products() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enroll_lifecycle_org_products() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_lifecycle_org_products() TO service_role;
-- Alphabetical order places this after creator capture for a new org.
CREATE TRIGGER zz_enroll_lifecycle_org_products AFTER INSERT OR UPDATE OF onboarding, email_preferences, management_email, created_by, customer_id, has_usage_credits ON public.orgs
FOR EACH ROW EXECUTE FUNCTION public.enroll_lifecycle_org_products();

-- Default org creation precedes asynchronous A/B allocation. A newly enrolled
-- creator wakes only their prospectively captured orgs via the creator index;
-- no current-owner lookup, historical backfill or global users/orgs scan occurs.
-- Dependency: PR1 protects abtests, abtests_enrolled and created_at from user
-- writes. Its enrollment cutoff is intentionally the same literal as above.
CREATE FUNCTION public.enroll_lifecycle_creator_products() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.lifecycle_v2_user_eligible(NEW.onboarding, NEW.created_at, NEW.created_via_invite)
    AND NOT public.lifecycle_v2_user_eligible(OLD.onboarding, OLD.created_at, OLD.created_via_invite) THEN
    INSERT INTO public.bento_lifecycle_journeys(org_id, product, selected_app_incarnation)
      SELECT c.org_id, p.product, public.lifecycle_v2_initial_app(c.org_id, p.product)
      FROM public.org_lifecycle_creators c
      JOIN public.orgs o ON o.id = c.org_id
      CROSS JOIN (VALUES ('ota'::text), ('builder'::text)) AS p(product)
      WHERE c.original_creator_id = NEW.id
        AND o.onboarding->>'intent' IN (p.product, 'both')
      ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.onboarding IS DISTINCT FROM OLD.onboarding
    OR NEW.created_via_invite IS DISTINCT FROM OLD.created_via_invite
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    UPDATE public.bento_lifecycle_journeys j
      SET candidate = NULL, revision = revision + 1, next_evaluation_at = pg_catalog.now()
      FROM public.org_lifecycle_creators c
      WHERE c.original_creator_id = NEW.id AND j.org_id = c.org_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enroll_lifecycle_creator_products() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enroll_lifecycle_creator_products() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_lifecycle_creator_products() TO service_role;
CREATE TRIGGER enroll_lifecycle_creator_products AFTER UPDATE OF onboarding, created_via_invite, created_at ON public.users
FOR EACH ROW EXECUTE FUNCTION public.enroll_lifecycle_creator_products();

-- At most two org/product rows per statement, never a plugin request path. Ignore
-- pre-migration apps: missing provenance/initial observation fails closed.
CREATE FUNCTION public.observe_lifecycle_app_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p text;
  v_capture boolean := TG_OP = 'INSERT';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.owner_org IS NOT DISTINCT FROM NEW.owner_org
      AND OLD.onboarding->'setup' IS NOT DISTINCT FROM NEW.onboarding->'setup'
      AND (OLD.onboarding #> '{features,cli_install,started_at}', OLD.onboarding #> '{features,ota,started_at}',
        OLD.onboarding #> '{features,ota,succeeded_at}', OLD.onboarding #> '{features,builder,started_at}', OLD.onboarding #> '{features,builder,succeeded_at}')
        IS NOT DISTINCT FROM
        (NEW.onboarding #> '{features,cli_install,started_at}', NEW.onboarding #> '{features,ota,started_at}',
        NEW.onboarding #> '{features,ota,succeeded_at}', NEW.onboarding #> '{features,builder,started_at}', NEW.onboarding #> '{features,builder,succeeded_at}')
    THEN
      RETURN NEW;
    END IF;
    v_capture := OLD.owner_org IS DISTINCT FROM NEW.owner_org;
  END IF;
  IF v_capture THEN
    FOREACH p IN ARRAY ARRAY['ota', 'builder'] LOOP
      INSERT INTO public.bento_lifecycle_app_observations(org_id, product, app_incarnation)
        SELECT NEW.owner_org, p, NEW.id FROM public.org_lifecycle_creators c WHERE c.org_id = NEW.owner_org
        ON CONFLICT (org_id, product, app_incarnation) DO UPDATE SET
          captured_at = EXCLUDED.captured_at, verified = '{}'::jsonb, verified_at = NULL, healthy = false;
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Preserve canonical readiness even if the app disappears before the first
    -- worker poll. Organization state and exhausted purposes are never reset.
    UPDATE public.bento_lifecycle_journeys j SET state = pg_catalog.jsonb_set(
      j.state, '{checklistCompleteAt}', pg_catalog.to_jsonb(pg_catalog.now()), true),
      candidate = NULL, revision = revision + 1, next_evaluation_at = pg_catalog.now()
      WHERE j.org_id = OLD.owner_org
        AND COALESCE(j.state->>'checklistCompleteAt', '') = ''
        AND EXISTS (SELECT 1 FROM public.bento_lifecycle_app_observations a
          WHERE a.org_id = j.org_id AND a.product = j.product AND a.app_incarnation = OLD.id)
        AND public.lifecycle_v2_checklist_complete(OLD.onboarding, j.product, OLD.created_at);
    UPDATE public.bento_lifecycle_journeys SET selected_app_incarnation = NULL,
      candidate = NULL, revision = revision + 1, next_evaluation_at = pg_catalog.now()
      WHERE org_id = OLD.owner_org AND selected_app_incarnation = OLD.id;
    RETURN OLD;
  END IF;
  UPDATE public.bento_lifecycle_journeys j SET state = pg_catalog.jsonb_set(
    j.state, '{checklistCompleteAt}', pg_catalog.to_jsonb(pg_catalog.now()), true),
    candidate = NULL, revision = revision + 1, next_evaluation_at = pg_catalog.now()
    WHERE j.org_id = NEW.owner_org
      AND COALESCE(j.state->>'checklistCompleteAt', '') = ''
      AND EXISTS (SELECT 1 FROM public.bento_lifecycle_app_observations a
        WHERE a.org_id = j.org_id AND a.product = j.product AND a.app_incarnation = NEW.id)
      AND public.lifecycle_v2_checklist_complete(NEW.onboarding, j.product, NEW.created_at);
  IF TG_OP = 'UPDATE' THEN
    UPDATE public.bento_lifecycle_journeys j SET state = pg_catalog.jsonb_set(
      j.state, '{checklistCompleteAt}', pg_catalog.to_jsonb(pg_catalog.now()), true),
      candidate = NULL, revision = revision + 1, next_evaluation_at = pg_catalog.now()
      WHERE j.org_id = OLD.owner_org
        AND COALESCE(j.state->>'checklistCompleteAt', '') = ''
        AND EXISTS (SELECT 1 FROM public.bento_lifecycle_app_observations a
          WHERE a.org_id = j.org_id AND a.product = j.product AND a.app_incarnation = OLD.id)
        AND public.lifecycle_v2_checklist_complete(OLD.onboarding, j.product, OLD.created_at);
  END IF;
  UPDATE public.bento_lifecycle_journeys j SET
    selected_app_incarnation = CASE WHEN (TG_OP = 'INSERT' OR v_capture
      OR OLD.onboarding->'setup' IS DISTINCT FROM NEW.onboarding->'setup')
      AND (NEW.onboarding #>> '{setup,selected_path}' = j.product
        OR (NEW.onboarding #> '{setup,paths}') = pg_catalog.jsonb_build_array(j.product))
      THEN NEW.id ELSE j.selected_app_incarnation END,
    candidate = NULL, revision = revision + 1, next_evaluation_at = pg_catalog.now()
    WHERE j.org_id = NEW.owner_org;
  IF TG_OP = 'UPDATE' AND OLD.owner_org IS DISTINCT FROM NEW.owner_org THEN
    UPDATE public.bento_lifecycle_journeys SET selected_app_incarnation = NULL,
      candidate = NULL, revision = revision + 1, next_evaluation_at = pg_catalog.now()
      WHERE org_id = OLD.owner_org AND selected_app_incarnation = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.observe_lifecycle_app_context() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.observe_lifecycle_app_context() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_lifecycle_app_context() TO service_role;
CREATE TRIGGER observe_lifecycle_app_context AFTER INSERT OR DELETE OR UPDATE OF onboarding, owner_org ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.observe_lifecycle_app_context();

-- Once per actual preference change, starting at finx_orgs_created_by and then
-- the journey org/product PK. User recipients can belong to several orgs; this
-- never scans unrelated users or enrolls an organization through a new owner.
CREATE FUNCTION public.wake_lifecycle_recipient_preferences() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.email_preferences, NEW.enable_notifications, NEW.opt_for_newsletters, NEW.email)
    IS DISTINCT FROM (OLD.email_preferences, OLD.enable_notifications, OLD.opt_for_newsletters, OLD.email) THEN
    UPDATE public.bento_lifecycle_journeys j SET candidate = NULL,
      revision = revision + 1, next_evaluation_at = pg_catalog.now()
      FROM public.orgs o WHERE o.created_by = NEW.id AND j.org_id = o.id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.wake_lifecycle_recipient_preferences() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_lifecycle_recipient_preferences() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_lifecycle_recipient_preferences() TO service_role;
CREATE TRIGGER wake_lifecycle_recipient_preferences
AFTER UPDATE OF email_preferences, enable_notifications, opt_for_newsletters, email ON public.users
FOR EACH ROW EXECUTE FUNCTION public.wake_lifecycle_recipient_preferences();

-- Stripe customer changes start at idx_orgs_customer_id, then the journey PK.
-- Trial extensions wake an existing purpose without changing its consumed state.
CREATE FUNCTION public.wake_lifecycle_billing_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.customer_id, NEW.status, NEW.trial_at, NEW.subscription_id)
      IS NOT DISTINCT FROM (OLD.customer_id, OLD.status, OLD.trial_at, OLD.subscription_id) THEN
      RETURN NEW;
    END IF;
    IF OLD.customer_id IS DISTINCT FROM NEW.customer_id THEN
      UPDATE public.bento_lifecycle_journeys j SET candidate = NULL,
        revision = revision + 1, next_evaluation_at = pg_catalog.now()
        FROM public.orgs o WHERE o.customer_id = OLD.customer_id AND j.org_id = o.id;
    END IF;
  END IF;
  UPDATE public.bento_lifecycle_journeys j SET candidate = NULL,
    revision = revision + 1, next_evaluation_at = pg_catalog.now()
    FROM public.orgs o WHERE o.customer_id = NEW.customer_id AND j.org_id = o.id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.wake_lifecycle_billing_state() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_lifecycle_billing_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_lifecycle_billing_state() TO service_role;
CREATE TRIGGER wake_lifecycle_billing_state
AFTER INSERT OR UPDATE OF customer_id, status, trial_at, subscription_id ON public.stripe_info
FOR EACH ROW EXECUTE FUNCTION public.wake_lifecycle_billing_state();

-- One apps.app_id PK lookup, at most one selected Builder journey, and one
-- onboarding_demo_data (app_id,relation_name,row_key) unique-key exclusion.
-- Seed identities are independent of app incarnation IDs. Old builds never wake a reused
-- app identifier. This is a build status write path, never plugin telemetry.
CREATE FUNCTION public.wake_lifecycle_builder_outcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.status, NEW.completed_at) IS NOT DISTINCT FROM (OLD.status, OLD.completed_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF COALESCE(NEW.builder_job_id, '') LIKE 'demo-job-%' OR NEW.upload_session_key LIKE 'demo-session-%' THEN
    RETURN NEW;
  END IF;
  UPDATE public.bento_lifecycle_journeys j SET candidate = NULL,
    revision = revision + 1, next_evaluation_at = pg_catalog.now()
    FROM public.apps a WHERE a.app_id = NEW.app_id AND a.owner_org = NEW.owner_org
      AND a.created_at <= NEW.created_at AND j.org_id = a.owner_org
      AND j.product = 'builder' AND j.selected_app_incarnation = a.id
      AND a.onboarding #>> '{setup,selected_builder_platform}' = NEW.platform
      AND NOT EXISTS (SELECT 1 FROM public.onboarding_demo_data d
        WHERE d.app_id = a.app_id AND d.relation_name = 'build_requests' AND d.row_key = NEW.id::text);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.wake_lifecycle_builder_outcome() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_lifecycle_builder_outcome() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_lifecycle_builder_outcome() TO service_role;
CREATE TRIGGER wake_lifecycle_builder_outcome AFTER INSERT OR UPDATE OF status, completed_at ON public.build_requests
FOR EACH ROW EXECUTE FUNCTION public.wake_lifecycle_builder_outcome();

-- Only operators/service_role can update this private domain-state field. A
-- single-row change wakes the journey and fences an already selected message;
-- operators need not coordinate a second next_evaluation_at write themselves.
CREATE FUNCTION public.wake_lifecycle_support_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.support_hold IS DISTINCT FROM OLD.support_hold THEN
    NEW.candidate := NULL;
    NEW.revision := OLD.revision + 1;
    NEW.next_evaluation_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.wake_lifecycle_support_hold() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_lifecycle_support_hold() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_lifecycle_support_hold() TO service_role;
CREATE TRIGGER wake_lifecycle_support_hold BEFORE UPDATE OF support_hold ON public.bento_lifecycle_journeys
FOR EACH ROW EXECUTE FUNCTION public.wake_lifecycle_support_hold();
