-- Admin-only AI reputation scores for Capgo apps.
-- Fame is independent of device counts: a nationally known bank can rank
-- above a high-MAU unknown utility. Scored by Workers AI on a cron; the
-- admin dashboard is read-only.

CREATE TABLE IF NOT EXISTS public.app_fame (
    app_id character varying NOT NULL,
    fame_score smallint NOT NULL,
    confidence smallint NOT NULL,
    tier text NOT NULL,
    category text,
    known_as text,
    summary text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_fame_pkey PRIMARY KEY (app_id),
    CONSTRAINT app_fame_app_id_fkey FOREIGN KEY (
        app_id
    ) REFERENCES public.apps (app_id) ON DELETE CASCADE,
    CONSTRAINT app_fame_score_range CHECK (
        (fame_score >= 0) AND (fame_score <= 100)
    ),
    CONSTRAINT app_fame_confidence_range CHECK (
        (confidence >= 0) AND (confidence <= 100)
    ),
    CONSTRAINT app_fame_tier_check CHECK (
        tier
        = any(
            ARRAY[
                'unknown'::text,
                'niche'::text,
                'notable'::text,
                'famous'::text,
                'iconic'::text
            ]
        )
    )
);

ALTER TABLE public.app_fame OWNER TO postgres;

COMMENT ON TABLE public.app_fame IS
'AI-assessed public reputation for Capgo apps. Admin observability only.';

COMMENT ON COLUMN public.app_fame.fame_score IS
'0-100 public-brand reputation. Independent of device counts.';

COMMENT ON COLUMN public.app_fame.tier IS
'unknown <30, niche <55, notable <75, famous <90, iconic >=90.';

CREATE INDEX IF NOT EXISTS app_fame_score_idx
ON public.app_fame (fame_score DESC, checked_at DESC);

CREATE INDEX IF NOT EXISTS app_fame_checked_at_idx
ON public.app_fame (checked_at);

ALTER TABLE public.app_fame ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny select on app_fame" ON public.app_fame;
CREATE POLICY "Deny select on app_fame"
ON public.app_fame
AS RESTRICTIVE
FOR SELECT
TO anon, authenticated
USING (false);

DROP POLICY IF EXISTS "Deny insert on app_fame" ON public.app_fame;
CREATE POLICY "Deny insert on app_fame"
ON public.app_fame
AS RESTRICTIVE
FOR INSERT
TO anon, authenticated
WITH CHECK (false);

DROP POLICY IF EXISTS "Deny update on app_fame" ON public.app_fame;
CREATE POLICY "Deny update on app_fame"
ON public.app_fame
AS RESTRICTIVE
FOR UPDATE
TO anon, authenticated
USING (false)
WITH CHECK (false);

DROP POLICY IF EXISTS "Deny delete on app_fame" ON public.app_fame;
CREATE POLICY "Deny delete on app_fame"
ON public.app_fame
AS RESTRICTIVE
FOR DELETE
TO anon, authenticated
USING (false);

GRANT ALL ON TABLE public.app_fame TO service_role;
REVOKE ALL ON TABLE public.app_fame FROM public;
REVOKE ALL ON TABLE public.app_fame FROM anon;
REVOKE ALL ON TABLE public.app_fame FROM authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pgmq.list_queues()
    WHERE queue_name = 'cron_app_fame'
  ) THEN
    PERFORM pgmq.create('cron_app_fame');
  END IF;
END;
$$;

INSERT INTO public.cron_tasks (
    name,
    description,
    task_type,
    target,
    batch_size,
    payload,
    second_interval,
    minute_interval,
    hour_interval,
    run_at_hour,
    run_at_minute,
    run_at_second,
    run_on_dow,
    run_on_day,
    enabled
) VALUES (
    'cron_app_fame',
    'Enqueue AI reputation scoring for a batch of Capgo apps',
    'queue',
    'cron_app_fame',
    12,
    jsonb_build_object(
        'function_name', 'cron_app_fame',
        'function_type', 'cloudflare'
    ),
    null,
    15,
    null,
    null,
    null,
    null,
    null,
    null,
    true
)
ON CONFLICT (name) DO UPDATE
    SET
        description = excluded.description,
        task_type = excluded.task_type,
        target = excluded.target,
        batch_size = excluded.batch_size,
        payload = excluded.payload,
        minute_interval = excluded.minute_interval,
        enabled = true,
        updated_at = pg_catalog.now();

INSERT INTO public.cron_tasks (
    name,
    description,
    task_type,
    target,
    batch_size,
    payload,
    second_interval,
    minute_interval,
    hour_interval,
    run_at_hour,
    run_at_minute,
    run_at_second,
    run_on_dow,
    run_on_day,
    enabled
) VALUES (
    'app_fame_queue',
    'Drain AI app reputation scoring queue',
    'function_queue',
    '["cron_app_fame"]',
    1,
    null,
    null,
    15,
    null,
    null,
    null,
    null,
    null,
    null,
    true
)
ON CONFLICT (name) DO UPDATE
    SET
        description = excluded.description,
        task_type = excluded.task_type,
        target = excluded.target,
        batch_size = excluded.batch_size,
        minute_interval = excluded.minute_interval,
        enabled = true,
        updated_at = pg_catalog.now();
