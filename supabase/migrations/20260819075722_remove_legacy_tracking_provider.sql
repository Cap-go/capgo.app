CREATE OR REPLACE FUNCTION public.process_admin_stats()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pgmq.send(
    'admin_stats',
    jsonb_build_object(
      'function_name', 'global_stats',
      'function_type', 'cloudflare',
      'payload', jsonb_build_object()
    )
  );
END;
$$;

ALTER FUNCTION public.process_admin_stats() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_admin_stats() FROM public;

-- Keep already queued admin-stat work compatible with the renamed HTTP routes.
-- The queue is bounded operational state; archived messages do not execute.
UPDATE pgmq.q_admin_stats
SET
    message = jsonb_set(
        message,
        '{function_name}',
        to_jsonb(
            'global_stats'
            || substr(
                message ->> 'function_name', length('logsnag_insights') + 1
            )
        )
    )
WHERE
    message ->> 'function_name' = 'logsnag_insights'
    OR message ->> 'function_name' LIKE 'logsnag_insights\_%' ESCAPE '\';

UPDATE public.global_stats
SET
    completed_shards = completed_shards
    - 'notifications_logsnag'
    - 'notifications_logsnag_claim'
WHERE
    completed_shards ? 'notifications_logsnag'
    OR completed_shards ? 'notifications_logsnag_claim';
