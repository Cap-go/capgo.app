ALTER TABLE "public"."org_stats_refresh_state"
ADD COLUMN "plan_calculated_at" timestamp with time zone;

COMMENT ON COLUMN "public"."org_stats_refresh_state"."plan_calculated_at"
IS 'Time when the organization plan state was last calculated successfully.';

COMMENT ON COLUMN "public"."stripe_info"."plan_calculated_at"
IS 'Deprecated compatibility column. Current plan calculation state is stored on org_stats_refresh_state.';

UPDATE "public"."org_stats_refresh_state" AS "state"
SET "plan_calculated_at" = "stripe"."plan_calculated_at"
FROM "public"."orgs" AS "org"
INNER JOIN "public"."stripe_info" AS "stripe"
  ON "stripe"."customer_id" = "org"."customer_id"
WHERE "state"."org_id" = "org"."id"
  AND "stripe"."plan_calculated_at" IS NOT NULL;

CREATE OR REPLACE FUNCTION "public"."mark_org_stats_refreshed"(
  "p_org_id" uuid, "p_stats_target_at" timestamp without time zone DEFAULT NULL)
RETURNS timestamp without time zone LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_target_at timestamp without time zone;
BEGIN
  INSERT INTO public.org_stats_refresh_state (org_id)
  SELECT org.id
  FROM public.orgs org
  WHERE org.id = p_org_id
  ON CONFLICT ON CONSTRAINT org_stats_refresh_state_pkey DO NOTHING;

  SELECT CASE
    WHEN p_stats_target_at IS NOT NULL THEN p_stats_target_at
    WHEN state.stats_refresh_requested_at IS NOT NULL
      AND (state.stats_updated_at IS NULL OR state.stats_refresh_requested_at > state.stats_updated_at)
      THEN state.stats_refresh_requested_at
    ELSE v_now_utc
  END
  INTO v_target_at
  FROM public.org_stats_refresh_state state
  WHERE state.org_id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.org_stats_refresh_state state
  SET stats_updated_at = GREATEST(COALESCE(state.stats_updated_at, v_target_at), v_target_at),
      stats_refresh_requested_at = GREATEST(COALESCE(state.stats_refresh_requested_at, v_target_at), v_target_at),
      plan_calculated_at = pg_catalog.clock_timestamp()
  WHERE state.org_id = p_org_id;

  RETURN v_target_at;
END;
$$;
ALTER FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) TO "service_role";
