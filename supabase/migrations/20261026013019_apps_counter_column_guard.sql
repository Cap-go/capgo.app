-- Keep system-maintained app counters out of reach of direct client writes.
--
-- apps.channel_device_count and apps.manifest_bundle_count are derived
-- counters maintained by backend/cron code (channel_device_counts queue,
-- manifest persist/cleanup, demo reset rollups). The plugin hot path reads them
-- to decide whether it needs to query channel_devices / manifest rows, so they
-- must stay in sync with the real data. The apps UPDATE RLS policy allows app
-- admins to patch the whole row, so pin both counters for client roles.
--
-- Execution profile for protect_apps_derived_counters (BEFORE INSERT, or
-- BEFORE UPDATE OF channel_device_count/manifest_bundle_count):
-- - Frequency: once per apps row inserted, or updated with either counter in
--   the SET list. Console-scale, not plugin hot path.
-- - Roles: only when current_user is authenticated/anon (PostgREST user JWT or
--   capgkey traffic) the counters are reset (INSERT -> 0, UPDATE -> OLD).
--   service_role, postgres, and SECURITY DEFINER maintainers (current_user is
--   the function owner) keep their writes unchanged.
-- - Cardinality: single-row trigger; no table access.
-- Mirrors the existing protect_apps_onboarding guard on the same table.

CREATE OR REPLACE FUNCTION "public"."protect_apps_derived_counters"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.channel_device_count := 0;
      NEW.manifest_bundle_count := 0;
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.channel_device_count := OLD.channel_device_count;
      NEW.manifest_bundle_count := OLD.manifest_bundle_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."protect_apps_derived_counters"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."protect_apps_derived_counters"() FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."protect_apps_derived_counters"() TO "service_role";

COMMENT ON FUNCTION "public"."protect_apps_derived_counters"() IS
  'BEFORE INSERT/UPDATE OF counters guard on apps. Client roles (authenticated/anon) cannot '
  'set channel_device_count or manifest_bundle_count; service_role, postgres and SECURITY '
  'DEFINER maintainers are unaffected.';

DROP TRIGGER IF EXISTS "protect_apps_derived_counters" ON "public"."apps";

CREATE TRIGGER "protect_apps_derived_counters"
  BEFORE INSERT OR UPDATE OF "channel_device_count", "manifest_bundle_count" ON "public"."apps"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."protect_apps_derived_counters"();
