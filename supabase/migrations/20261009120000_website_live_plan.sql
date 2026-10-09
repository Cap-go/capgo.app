-- Website Live: a low-cost plan where the customer's deployed static website is
-- the update source. The updater plugin only asks GET /website_live whether
-- the app may update and which website URL to download from; no channels,
-- stats, bundle uploads or encryption are involved.

-- 1) Plan kind: keep Website Live out of every usage-based plan recommendation.
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'full';

ALTER TABLE public.plans
  DROP CONSTRAINT IF EXISTS plans_kind_check;
ALTER TABLE public.plans
  ADD CONSTRAINT plans_kind_check CHECK (kind IN ('full', 'website'));

COMMENT ON COLUMN public.plans.kind IS
  'full: classic Capgo plan (channels, stats, bundles). website: Website Live plan, updates come from the app website_url and usage-based limits are zero.';

-- The Website Live plan row itself is not inserted here: it needs the live
-- Stripe product/price ids and ships in a follow-up migration once they exist.
-- Until then the console hides Website Live (no plan with kind = 'website').
-- Its usage limits must be zero (mau, storage, bandwidth, build_time_unit), so
-- any classic Capgo usage on this plan marks the org as exceeded, while
-- /website_live only checks that the subscription is active.

CREATE OR REPLACE FUNCTION public.find_best_plan_v3(
  mau bigint,
  bandwidth double precision,
  storage double precision,
  build_time_unit bigint DEFAULT 0
) RETURNS character varying
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  RETURN (
    SELECT name
    FROM public.plans
    WHERE plans.kind = 'full'
      AND (
        (
          plans.mau >= find_best_plan_v3.mau
          AND plans.storage >= find_best_plan_v3.storage
          AND plans.bandwidth >= find_best_plan_v3.bandwidth
          AND plans.build_time_unit >= find_best_plan_v3.build_time_unit
        ) OR plans.name = 'Enterprise'
      )
    ORDER BY plans.mau
    LIMIT 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.find_fit_plan_v3(
  mau bigint,
  bandwidth bigint,
  storage bigint,
  build_time_unit bigint DEFAULT 0
) RETURNS TABLE(name character varying)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
BEGIN
  RETURN QUERY (SELECT plans.name FROM public.plans
    WHERE plans.kind = 'full'
      AND (
        plans.mau >= find_fit_plan_v3.mau AND plans.storage >= find_fit_plan_v3.storage
        AND plans.bandwidth >= find_fit_plan_v3.bandwidth AND plans.build_time_unit >= find_fit_plan_v3.build_time_unit
        OR plans.name = 'Enterprise'
      )
    ORDER BY plans.mau);
END;
$$;

-- 2) App update mode. Nullable/default-backed so the read replica subscriber
-- can add the columns before the primary (additive replica sync).
ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS update_mode text NOT NULL DEFAULT 'capgo',
  ADD COLUMN IF NOT EXISTS website_url text;

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_update_mode_check;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_update_mode_check CHECK (update_mode IN ('capgo', 'website'));

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_website_url_check;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_website_url_check CHECK (
    website_url IS NULL
    OR (
      pg_catalog.length(website_url) <= 2048
      -- Root of the domain only: the updater stores files relative to the bundle root.
      -- Public domain names only (no IP literals, localhost or single-label hosts).
      AND website_url ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+([A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})(:[0-9]{1,5})?/?$'
    )
  );

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_website_mode_requires_url;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_website_mode_requires_url CHECK (update_mode <> 'website' OR website_url IS NOT NULL);

COMMENT ON COLUMN public.apps.update_mode IS
  'capgo: classic Capgo updates (bundles, channels, stats). website: Website Live, the updater downloads the static site at website_url after GET /website_live allows it.';
COMMENT ON COLUMN public.apps.website_url IS
  'HTTPS URL of the deployed static web build used as the update source in website update mode.';

-- 3) Purge the plugin edge cache (incl. /website_live answers) when the update
-- mode or website URL changes. Same function as 20261004012047 plus the two
-- new apps columns in the change detection tuple.
CREATE OR REPLACE FUNCTION public.invalidate_updates_edge_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app_ids text[];
  version_app_ids text[];
BEGIN
  IF NOT public.updates_cache_purge_enabled() THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'channels' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids FROM old_rows o;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT changed.app_id) INTO app_ids
      FROM (
        SELECT o.app_id::text AS app_id FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.app_id, o.name, o.version, o.public, o.allow_device_self_set, o.allow_emulator,
               o.allow_device, o.allow_dev, o.allow_prod, o.disable_auto_update_under_native,
               o.disable_auto_update, o.ios, o.android, o.electron, o.update_package,
               o.rollout_version, o.rollout_percentage_bps, o.rollout_enabled, o.rollout_id,
               o.rollout_paused_at, o.rollout_pause_reason, o.rollout_cache_ttl_seconds, o.paused_at,
               o.owner_org)
          IS DISTINCT FROM
              (n.app_id, n.name, n.version, n.public, n.allow_device_self_set, n.allow_emulator,
               n.allow_device, n.allow_dev, n.allow_prod, n.disable_auto_update_under_native,
               n.disable_auto_update, n.ios, n.android, n.electron, n.update_package,
               n.rollout_version, n.rollout_percentage_bps, n.rollout_enabled, n.rollout_id,
               n.rollout_paused_at, n.rollout_pause_reason, n.rollout_cache_ttl_seconds, n.paused_at,
               n.owner_org)
        UNION
        SELECT n.app_id::text FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE o.app_id IS DISTINCT FROM n.app_id
      ) AS changed;
    END IF;
  ELSIF TG_TABLE_NAME = 'apps' THEN
    IF TG_OP = 'INSERT' THEN
      -- Clears the cached "unknown app" answer.
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids FROM old_rows o;
    ELSE
      -- Counters only gate code paths (> 0), so only zero crossings matter.
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids
      FROM old_rows o JOIN new_rows n ON n.app_id = o.app_id
      WHERE (o.owner_org, o.expose_metadata, o.allow_device_custom_id, o.block_provider_infra_requests,
             o.rollout_paused_version_names, o.update_mode, o.website_url,
             COALESCE(o.channel_device_count, 0) > 0, COALESCE(o.manifest_bundle_count, 0) > 0,
             COALESCE(o.rollout_channel_count, 0) > 0)
        IS DISTINCT FROM
            (n.owner_org, n.expose_metadata, n.allow_device_custom_id, n.block_provider_infra_requests,
             n.rollout_paused_version_names, n.update_mode, n.website_url,
             COALESCE(n.channel_device_count, 0) > 0, COALESCE(n.manifest_bundle_count, 0) > 0,
             COALESCE(n.rollout_channel_count, 0) > 0);
    END IF;
  ELSIF TG_TABLE_NAME = 'app_versions' THEN
    -- Main tag: only versions a channel serves (as version or rollout target)
    -- can be in the /updates entries; channel changes that start serving a
    -- version purge on their own. This keeps uploads (manifest_count,
    -- storage_provider flips of unlinked bundles) from evicting the app's live
    -- entries.
    -- Versions tag: bundle-name lookups (id + owner_org by name, deleted rows
    -- included) change on any insert, delete, rename, move or soft delete,
    -- whether or not a channel serves the version.
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO version_app_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids
      FROM old_rows o
      WHERE EXISTS (
        SELECT 1 FROM public.channels c WHERE c.version = o.id OR c.rollout_version = o.id
      );
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO version_app_ids FROM old_rows o;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids
      FROM old_rows o JOIN new_rows n ON n.id = o.id
      WHERE EXISTS (
        SELECT 1 FROM public.channels c WHERE c.version = n.id OR c.rollout_version = n.id
      )
        AND (o.app_id, o.name, o.checksum, o.session_key, o.key_id, o.storage_provider, o.external_url,
             o.min_update_version, o.manifest_count, o.r2_path, o.deleted, o.deleted_at,
             o.link, o.comment)
        IS DISTINCT FROM
            (n.app_id, n.name, n.checksum, n.session_key, n.key_id, n.storage_provider, n.external_url,
             n.min_update_version, n.manifest_count, n.r2_path, n.deleted, n.deleted_at,
             n.link, n.comment);
      SELECT pg_catalog.array_agg(DISTINCT changed.app_id) INTO version_app_ids
      FROM (
        SELECT n.app_id::text AS app_id FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.app_id, o.name, o.owner_org, o.deleted)
          IS DISTINCT FROM (n.app_id, n.name, n.owner_org, n.deleted)
        UNION
        SELECT o.app_id::text FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE o.app_id IS DISTINCT FROM n.app_id
      ) AS changed;
    END IF;
  ELSIF TG_TABLE_NAME = 'orgs' THEN
    SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    JOIN public.apps a ON a.owner_org = n.id
    WHERE (o.customer_id, o.has_usage_credits, o.management_email, o.created_by)
      IS DISTINCT FROM
          (n.customer_id, n.has_usage_credits, n.management_email, n.created_by);
  ELSIF TG_TABLE_NAME = 'stripe_info' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM new_rows s
      JOIN public.orgs org ON org.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = org.id;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM old_rows s
      JOIN public.orgs org ON org.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = org.id;
    ELSE
      -- storage_exceeded is left out on purpose: plugin plan checks only use
      -- the mau and bandwidth actions (see buildPlanValidationExpression).
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM old_rows o
      JOIN new_rows n ON n.customer_id = o.customer_id
      JOIN public.orgs org ON org.customer_id = n.customer_id
      JOIN public.apps a ON a.owner_org = org.id
      WHERE (o.status, o.trial_at, o.mau_exceeded, o.bandwidth_exceeded)
        IS DISTINCT FROM
            (n.status, n.trial_at, n.mau_exceeded, n.bandwidth_exceeded);
    END IF;
  END IF;

  IF app_ids IS NOT NULL THEN
    PERFORM public.notify_updates_edge_cache_purge(app_ids, 'app');
  END IF;
  IF version_app_ids IS NOT NULL THEN
    PERFORM public.notify_updates_edge_cache_purge(version_app_ids, 'versions');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'invalidate_updates_edge_cache failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.invalidate_updates_edge_cache() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invalidate_updates_edge_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_updates_edge_cache() FROM anon, authenticated;

COMMENT ON FUNCTION public.invalidate_updates_edge_cache() IS
  'Statement-level AFTER trigger: collects app ids whose plugin edge cache '
  'entries may have changed and asks triggers/updates_cache_purge to purge '
  'their Cloudflare Cache-Tag (scope app: /updates, owner and channel lookups; '
  'scope versions: bundle-name lookups). Runs once per statement over '
  'transition tables; lookups use finx_channels_version, '
  'idx_channels_rollout_version, idx_orgs_customer_id and finx_apps_owner_org.';

COMMENT ON COLUMN "public"."users"."onboarding" IS 'Persisted create-app onboarding wizard progress for resume and admin drop-off. Keys: status, step, flow, final_step, development_environment, intent, details_step, setup_stage, app_name, app_id, existing_app, existing_app_setup, store_url, imported_store_app_id, org_name, estimated_users_index, update_mode, website_url, onboarding_attempt_id, last_run_id, abtests, updated_at, completed_at.';
