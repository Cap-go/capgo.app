-- Private evaluation runner. No reminder enrollment trigger, public RPC,
-- extension, or Supabase cron is introduced. Cadences are code configuration.
CREATE TABLE public.bento_event_dispatches (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    flow_key text NOT NULL,
    context_key text NOT NULL,
    recipient_key text NOT NULL,
    email text NOT NULL,
    tag text NOT NULL,
    status text NOT NULL CHECK (
        status IN ('recorded', 'sending', 'accepted', 'failed')
    ),
    event_at timestamptz,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    claim_token uuid,
    claim_until timestamptz,
    attempt_count smallint NOT NULL DEFAULT 0 CHECK (
        attempt_count BETWEEN 0 AND 5
    ),
    last_attempt_at timestamptz,
    last_error text,
    closed_at timestamptz,
    last_run_id uuid,
    pending_audit jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        pg_catalog.jsonb_typeof(pending_audit) = 'array'
    ),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    UNIQUE (flow_key, context_key, recipient_key, tag)
);
ALTER TABLE public.bento_event_dispatches OWNER TO postgres;
ALTER TABLE public.bento_event_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bento_event_dispatches FROM public,
anon,
authenticated;
GRANT SELECT,
INSERT,
UPDATE,
DELETE ON TABLE public.bento_event_dispatches TO service_role;
CREATE POLICY deny_user_bento_event_dispatches ON public.bento_event_dispatches
AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE INDEX bento_event_dispatches_active_idx
ON public.bento_event_dispatches (flow_key, (details ->> 'kind'), event_at, id)
WHERE tag = 'flow:started' AND closed_at IS null;
CREATE INDEX bento_event_dispatches_last_attempt_idx
ON public.bento_event_dispatches (
    last_attempt_at
)
WHERE last_attempt_at IS NOT null;
CREATE INDEX bento_event_dispatches_pending_audit_idx
ON public.bento_event_dispatches (
    id
)
WHERE pending_audit <> '[]'::jsonb;

CREATE TABLE public.bento_evaluation_runs (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    evaluation_key text NOT NULL,
    scheduled_for timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending_enqueue'
    CHECK (
        status IN (
            'pending_enqueue', 'queued', 'running', 'completed', 'failed'
        )
    ),
    enqueued_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    enqueue_claim_token uuid,
    enqueue_claim_until timestamptz,
    enqueue_attempt_count smallint NOT NULL DEFAULT 0 CHECK (
        enqueue_attempt_count BETWEEN 0 AND 5
    ),
    execution_claim_token uuid,
    execution_claim_until timestamptz,
    execution_attempt_count smallint NOT NULL DEFAULT 0 CHECK (
        execution_attempt_count BETWEEN 0 AND 5
    ),
    eligible_users jsonb,
    evaluated_at timestamptz,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error text,
    pending_audit jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        pg_catalog.jsonb_typeof(pending_audit) = 'array'
    ),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
ALTER TABLE public.bento_evaluation_runs OWNER TO postgres;
ALTER TABLE public.bento_evaluation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bento_evaluation_runs FROM public,
anon,
authenticated;
GRANT SELECT,
INSERT,
UPDATE,
DELETE ON TABLE public.bento_evaluation_runs TO service_role;
CREATE POLICY deny_user_bento_evaluation_runs ON public.bento_evaluation_runs
AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE INDEX bento_evaluation_runs_latest_idx
ON public.bento_evaluation_runs (
    evaluation_key, created_at DESC, id DESC
);
CREATE INDEX bento_evaluation_runs_enqueued_idx
ON public.bento_evaluation_runs (
    evaluation_key, enqueued_at DESC
) WHERE enqueued_at IS NOT null;
CREATE UNIQUE INDEX bento_evaluation_runs_unfinished_idx
ON public.bento_evaluation_runs (
    evaluation_key
)
WHERE status IN ('pending_enqueue', 'queued', 'running');
CREATE INDEX bento_evaluation_runs_pending_audit_idx
ON public.bento_evaluation_runs (
    id
)
WHERE pending_audit <> '[]'::jsonb;
COMMENT ON TABLE public.bento_event_dispatches IS
'Private logical event ledger. accepted means Bento acknowledgement,
not inbox delivery. Source tokens and provider payloads are resolved fresh.
Pending analytics shares this ledger.';
COMMENT ON TABLE public.bento_evaluation_runs IS
'Private evaluation history and complete safe eligibility snapshots.
Queue publication and execution are fenced separately.
Pending analytics shares this ledger.';
