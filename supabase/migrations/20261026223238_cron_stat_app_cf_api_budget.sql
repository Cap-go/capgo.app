-- cron_stat_app reads MAU, bandwidth and version usage from Analytics Engine:
-- three SQL API calls per app on api.cloudflare.com, which allows 1,200
-- requests per 5 minutes per token and answers HTTP 429 to every call for the
-- next 5 minutes once that is exceeded
-- (https://developers.cloudflare.com/fundamentals/api/reference/limits/).
-- Sharing per_minute_queues at batch_size 10 let the dispatcher send up to
-- 10 calls x 10 messages = 100 apps/min = 1,500 requests per 5 minutes, so the
-- 6-hourly stats bursts failed with 500s and burned retry reads.
-- Give cron_stat_app its own task at batch_size 5: at most 50 apps/min, i.e.
-- 750 requests per 5 minutes, leaving headroom for dashboard reads on the
-- same token. The queue absorbs the burst: the ~2,500 apps of a 6-hourly run
-- now drain in about 50 minutes instead of 25.
UPDATE public.cron_tasks
SET
    target = (target::jsonb - 'cron_stat_app')::text,
    updated_at = pg_catalog.now()
WHERE
    name = 'per_minute_queues'
    AND task_type = 'function_queue'
    AND target::jsonb ? 'cron_stat_app';

INSERT INTO public.cron_tasks (
    name, task_type, target, batch_size, minute_interval, description
)
VALUES
(
    'stat_app_queue',
    'function_queue',
    '["cron_stat_app"]',
    5,
    1,
    'Consume up to 10 batches of 5 apps per minute (50 apps, 150 Analytics '
    || 'Engine queries) to stay under the Cloudflare API limit'
);
