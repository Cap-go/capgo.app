-- Targeted invalidation for the /updates colo cache
-- (see supabase/functions/_backend/utils/updates_colo_cache.ts).
--
-- Whenever a row that feeds the update hot path changes, notify the
-- triggers/cache_invalidate function (via pg_net, async, ~ms overhead per
-- write) which fans the per-app token bump out to every regional plugin
-- worker. The cache TTL remains the backstop if a call is lost.

CREATE OR REPLACE FUNCTION public.invalidate_updates_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app_ids text[];
BEGIN
  IF TG_TABLE_NAME IN ('channels', 'channel_devices', 'app_versions', 'apps') THEN
    IF TG_OP = 'DELETE' THEN
      app_ids := ARRAY[OLD.app_id::text];
    ELSE
      app_ids := ARRAY[NEW.app_id::text];
    END IF;
  ELSIF TG_TABLE_NAME = 'orgs' THEN
    SELECT array_agg(a.app_id::text) INTO app_ids
    FROM public.apps a
    WHERE a.owner_org = NEW.id;
  ELSIF TG_TABLE_NAME = 'stripe_info' THEN
    SELECT array_agg(a.app_id::text) INTO app_ids
    FROM public.apps a
    JOIN public.orgs o ON o.id = a.owner_org
    WHERE o.customer_id = NEW.customer_id;
  END IF;

  IF app_ids IS NOT NULL AND array_length(app_ids, 1) > 0 THEN
    PERFORM net.http_post(
      url := public.get_db_url() || '/functions/v1/triggers/cache_invalidate',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apisecret', public.get_apikey()
      ),
      body := jsonb_build_object('app_ids', to_jsonb(app_ids)),
      timeout_milliseconds := 5000
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- channels: any change moves versions/flags devices resolve against.
CREATE TRIGGER invalidate_updates_cache_channels
AFTER INSERT OR UPDATE OR DELETE ON public.channels
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

-- channel_devices: flips or edits per-device overrides; must react fast so
-- an app gaining its FIRST override switches off the cached no-override
-- fast path immediately (apps.channel_device_count is inside the cached
-- payload).
CREATE TRIGGER invalidate_updates_cache_channel_devices
AFTER INSERT OR UPDATE OR DELETE ON public.channel_devices
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

-- apps: counters, plan/provider flags, metadata exposure. INSERT clears the
-- negative (unknown-app) cache entry the moment an app is created. The
-- UPDATE trigger is column-scoped so stats churn (stats_updated_at etc.)
-- never storms the invalidation path.
CREATE TRIGGER invalidate_updates_cache_apps_ins_del
AFTER INSERT OR DELETE ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

CREATE TRIGGER invalidate_updates_cache_apps_upd
AFTER UPDATE OF
  channel_device_count,
  manifest_bundle_count,
  rollout_channel_count,
  rollout_paused_version_names,
  expose_metadata,
  allow_device_custom_id,
  block_provider_infra_requests,
  owner_org
ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

-- app_versions: UPDATE only (r2_path/checksum/deleted change after a channel
-- may already point at the version; freshly inserted rows are not yet referenced).
CREATE TRIGGER invalidate_updates_cache_app_versions
AFTER UPDATE ON public.app_versions
FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION public.invalidate_updates_cache();

-- orgs: only the columns feeding plan validation / app ownership; the
-- frequent stats_updated_at churn must not fan out.
CREATE TRIGGER invalidate_updates_cache_orgs
AFTER UPDATE OF customer_id, has_usage_credits, created_by, management_email
ON public.orgs
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

-- stripe_info: only the columns feeding plan validation; hourly
-- plan_usage/updated_at churn must not fan out.
CREATE TRIGGER invalidate_updates_cache_stripe_info_ins
AFTER INSERT ON public.stripe_info
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

CREATE TRIGGER invalidate_updates_cache_stripe_info_upd
AFTER UPDATE OF status, trial_at, mau_exceeded, storage_exceeded, bandwidth_exceeded, customer_id
ON public.stripe_info
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();
