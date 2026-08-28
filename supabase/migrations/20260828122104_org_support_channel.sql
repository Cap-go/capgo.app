-- Dedicated Slack / Discord / Teams channel for enterprise orgs.
-- Capgo admins set it through /private/admin_org_support_channel (service_role).
-- Org members can read it; they cannot change it via PostgREST.

ALTER TABLE public.orgs
  ADD COLUMN IF NOT EXISTS support_channel_type text,
  ADD COLUMN IF NOT EXISTS support_channel_url text,
  ADD COLUMN IF NOT EXISTS support_channel_set_at timestamp with time zone;

ALTER TABLE public.orgs
  DROP CONSTRAINT IF EXISTS orgs_support_channel_type_check;
ALTER TABLE public.orgs
  ADD CONSTRAINT orgs_support_channel_type_check
  CHECK (
    support_channel_type IS NULL
    OR support_channel_type = ANY (ARRAY['slack'::text, 'discord'::text, 'teams'::text])
  );

ALTER TABLE public.orgs
  DROP CONSTRAINT IF EXISTS orgs_support_channel_url_check;
ALTER TABLE public.orgs
  ADD CONSTRAINT orgs_support_channel_url_check
  CHECK (
    (
      support_channel_type IS NULL
      AND support_channel_url IS NULL
    )
    OR (
      support_channel_type IS NOT NULL
      AND support_channel_url IS NOT NULL
      AND char_length(support_channel_url) <= 2048
      AND support_channel_url ~ '^https://'
    )
  );

COMMENT ON COLUMN public.orgs.support_channel_type IS
  'Capgo-admin-managed support channel kind for the org: slack, discord, or teams.';
COMMENT ON COLUMN public.orgs.support_channel_url IS
  'HTTPS invite/link for the org support channel. Null when unset.';
COMMENT ON COLUMN public.orgs.support_channel_set_at IS
  'When the support channel was first set. Used for enterprise adoption charts.';

CREATE OR REPLACE FUNCTION public.guard_org_support_channel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_request_role text := public.current_request_role();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.support_channel_type IS NOT NULL
       OR NEW.support_channel_url IS NOT NULL
       OR NEW.support_channel_set_at IS NOT NULL THEN
      IF NOT public.is_internal_request_role(v_request_role) THEN
        RAISE EXCEPTION 'ORG_SUPPORT_CHANNEL_CLIENT_WRITE_DENIED'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.support_channel_url IS NOT NULL THEN
      NEW.support_channel_set_at := COALESCE(NEW.support_channel_set_at, now());
    ELSE
      NEW.support_channel_type := NULL;
      NEW.support_channel_set_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.support_channel_type IS DISTINCT FROM OLD.support_channel_type
     OR NEW.support_channel_url IS DISTINCT FROM OLD.support_channel_url
     OR NEW.support_channel_set_at IS DISTINCT FROM OLD.support_channel_set_at THEN
    IF NOT public.is_internal_request_role(v_request_role) THEN
      RAISE EXCEPTION 'ORG_SUPPORT_CHANNEL_CLIENT_WRITE_DENIED'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.support_channel_url IS NULL THEN
    NEW.support_channel_type := NULL;
    NEW.support_channel_set_at := NULL;
  ELSIF OLD.support_channel_url IS NULL THEN
    NEW.support_channel_set_at := COALESCE(NEW.support_channel_set_at, now());
  ELSE
    NEW.support_channel_set_at := COALESCE(OLD.support_channel_set_at, now());
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_org_support_channel() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_org_support_channel() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_org_support_channel() TO service_role;

COMMENT ON FUNCTION public.guard_org_support_channel() IS
  'BEFORE INSERT OR UPDATE trigger on public.orgs (per row). Blocks client writes '
  'to support_channel_* columns; internal roles (service_role, postgres, '
  'supabase_admin) bypass. Also stamps support_channel_set_at on first set and '
  'clears it when the URL is removed. Table cardinality: orgs is large, but the '
  'trigger is O(1) OLD/NEW field comparisons with no SQL queries. Indexes: not '
  'applicable.';

DROP TRIGGER IF EXISTS guard_org_support_channel ON public.orgs;
CREATE TRIGGER guard_org_support_channel
BEFORE INSERT OR UPDATE ON public.orgs
FOR EACH ROW
EXECUTE FUNCTION public.guard_org_support_channel();
