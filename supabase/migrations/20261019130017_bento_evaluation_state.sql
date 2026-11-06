-- Reuse one execution-state row per evaluation, preserving any unfinished run
-- and all unhanded analytics before discarding redundant completed history.
BEGIN;

LOCK TABLE public.bento_evaluation_runs IN ACCESS EXCLUSIVE MODE;

WITH retained AS MATERIALIZED (
    SELECT DISTINCT ON (evaluation_key)
        id,
        evaluation_key
    FROM public.bento_evaluation_runs
    ORDER BY
        evaluation_key ASC,
        (status IN ('pending_enqueue', 'queued', 'running')) DESC,
        created_at DESC, id DESC
),

audits AS (
    SELECT
        runs.evaluation_key,
        jsonb_agg(
            pending_event.audit_body
            ORDER BY runs.created_at, runs.id, pending_event.audit_sequence
        ) AS pending_audit
    FROM public.bento_evaluation_runs AS runs
    CROSS JOIN
        LATERAL jsonb_array_elements(runs.pending_audit)
        WITH ORDINALITY AS pending_event (audit_body, audit_sequence)
    GROUP BY runs.evaluation_key
)

UPDATE public.bento_evaluation_runs AS target
SET pending_audit = audits.pending_audit
FROM retained
INNER JOIN audits ON retained.evaluation_key = audits.evaluation_key
WHERE target.id = retained.id;

WITH ranked AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY evaluation_key
            ORDER BY
                (status IN ('pending_enqueue', 'queued', 'running')) DESC,
                created_at DESC, id DESC
        ) AS run_rank
    FROM public.bento_evaluation_runs
)

DELETE FROM public.bento_evaluation_runs AS obsolete
USING ranked
WHERE obsolete.id = ranked.id AND ranked.run_rank > 1;

ALTER TABLE public.bento_evaluation_runs
ADD CONSTRAINT bento_evaluation_runs_evaluation_key_key UNIQUE (evaluation_key);

DROP INDEX public.bento_evaluation_runs_latest_idx;
DROP INDEX public.bento_evaluation_runs_enqueued_idx;
DROP INDEX public.bento_evaluation_runs_unfinished_idx;

COMMENT ON TABLE public.bento_evaluation_runs IS
'Reusable private evaluation state: one row per evaluation_key.
The id rotates per scheduled run to fence stale messages.
Eligibility snapshots and pending analytics survive retries.';

COMMIT;
