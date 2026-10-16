-- Server-only identity-bound first-authorization names. Clients cannot select or
-- write these records; Apple signatures and per-attempt nonces are checked first.
CREATE TABLE public.apple_auth_names (
    subject text PRIMARY KEY CHECK (length(subject) BETWEEN 1 AND 255),
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name text NOT NULL DEFAULT '' CHECK (length(first_name) <= 100),
    last_name text NOT NULL DEFAULT '' CHECK (length(last_name) <= 100),
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.apple_auth_names OWNER TO postgres;
ALTER TABLE public.apple_auth_names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apple_auth_names FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.apple_auth_names TO service_role;
CREATE POLICY apple_auth_names_server ON public.apple_auth_names TO service_role USING (true) WITH CHECK (true);
CREATE INDEX apple_auth_names_pending_expiry_idx ON public.apple_auth_names (created_at) WHERE user_id IS NULL;

CREATE TABLE public.apple_auth_attempts (
    state_hash text PRIMARY KEY,
    nonce text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    client_state text NOT NULL,
    expected_user_id uuid,
    expected_subject text,
    registration_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    exchange_hash text UNIQUE,
    credential text,
    callback_claimed boolean NOT NULL DEFAULT false,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);
ALTER TABLE public.apple_auth_attempts OWNER TO postgres;
ALTER TABLE public.apple_auth_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apple_auth_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.apple_auth_attempts TO service_role;
CREATE POLICY apple_auth_attempts_server ON public.apple_auth_attempts TO service_role USING (true) WITH CHECK (true);
CREATE INDEX apple_auth_attempts_expiry_idx ON public.apple_auth_attempts (expires_at);

CREATE TABLE public.apple_auth_token_uses (
    token_hash text PRIMARY KEY,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);
ALTER TABLE public.apple_auth_token_uses OWNER TO postgres;
ALTER TABLE public.apple_auth_token_uses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apple_auth_token_uses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.apple_auth_token_uses TO service_role;
CREATE POLICY apple_auth_token_uses_server ON public.apple_auth_token_uses TO service_role USING (true) WITH CHECK (true);
CREATE INDEX apple_auth_token_uses_expiry_idx ON public.apple_auth_token_uses (expires_at);

-- All lookups use the primary/unique keys. Expiry cleanup is bounded by the
-- expiry index at OAuth start; it never scans profiles or other resource tables.
