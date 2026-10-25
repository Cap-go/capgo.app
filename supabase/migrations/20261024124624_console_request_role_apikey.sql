-- The console connection logs in as postgres and switches with SET LOCAL ROLE.
-- That leaves session_user as postgres. This trigger used that as "service
-- caller" and skipped key generation. A user-facing request role must still
-- regenerate the key. A postgres session with no user role stays a service
-- caller, which is what migrations and internal jobs rely on.

CREATE OR REPLACE FUNCTION public.apikeys_force_server_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plain_key text;
  v_is_hashed boolean;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF current_setting('capgo.skip_apikey_trigger', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- SECURITY DEFINER makes current_user the function owner. session_user is the
  -- login role, which stays postgres under SET ROLE. Treat that as service only
  -- when the request did not claim authenticated or anon.
  IF COALESCE(session_user, '') = ANY (public.internal_request_db_user_names())
    AND public.current_request_role() NOT IN ('authenticated', 'anon')
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Allow callers to force regeneration even if they mistakenly re-submit the same value.
    -- This is primarily useful for controlled internal operations; normal API flows always
    -- write a different placeholder value.
    IF current_setting('capgo.force_regenerate_apikey', true) IS DISTINCT FROM 'true'
      AND NEW.key IS NOT DISTINCT FROM OLD.key
      AND NEW.key_hash IS NOT DISTINCT FROM OLD.key_hash THEN
      RETURN NEW;
    END IF;
    v_is_hashed := (OLD.key_hash IS NOT NULL AND OLD.key IS NULL) OR NEW.key_hash IS NOT NULL;
  ELSE
    v_is_hashed := NEW.key_hash IS NOT NULL;
  END IF;

  v_plain_key := gen_random_uuid()::text;

  IF v_is_hashed THEN
    NEW.key_hash := encode(extensions.digest(v_plain_key, 'sha256'), 'hex');
    NEW.key := v_plain_key;
  ELSE
    NEW.key := v_plain_key;
    NEW.key_hash := NULL;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.apikeys_force_server_key() OWNER TO postgres;
