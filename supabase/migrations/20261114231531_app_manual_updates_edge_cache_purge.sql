-- Per-app rate limit for console-initiated /updates edge cache purges.

CREATE TABLE public.app_manual_updates_edge_purge (
  app_id character varying NOT NULL,
  last_purged_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT app_manual_updates_edge_purge_pkey PRIMARY KEY (app_id),
  CONSTRAINT app_manual_updates_edge_purge_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps (app_id) ON DELETE CASCADE
);

ALTER TABLE public.app_manual_updates_edge_purge OWNER TO postgres;

ALTER TABLE public.app_manual_updates_edge_purge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny all direct access"
ON public.app_manual_updates_edge_purge
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.try_claim_manual_updates_edge_purge(p_app_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_last timestamp with time zone;
  v_wait_seconds integer;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after_seconds', 60);
  END IF;

  SELECT last_purged_at
  INTO v_last
  FROM public.app_manual_updates_edge_purge
  WHERE app_id = p_app_id
  FOR UPDATE;

  IF FOUND AND v_last > v_now - interval '1 minute' THEN
    v_wait_seconds := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_last + interval '1 minute' - v_now))));
    RETURN jsonb_build_object('allowed', false, 'retry_after_seconds', v_wait_seconds);
  END IF;

  INSERT INTO public.app_manual_updates_edge_purge (app_id, last_purged_at)
  VALUES (p_app_id, v_now)
  ON CONFLICT (app_id) DO UPDATE
  SET last_purged_at = excluded.last_purged_at;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

ALTER FUNCTION public.try_claim_manual_updates_edge_purge(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.try_claim_manual_updates_edge_purge(text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.try_claim_manual_updates_edge_purge(text) TO service_role;