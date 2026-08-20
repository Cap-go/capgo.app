BEGIN;

SELECT plan(14);

CREATE OR REPLACE FUNCTION pg_temp.send_email_payload()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_payload jsonb;
BEGIN
    IF pg_catalog.to_regclass('pgmq.q_send_email') IS NULL THEN
        RETURN NULL;
    END IF;

    EXECUTE
        'SELECT message -> ''payload''
         FROM pgmq.q_send_email
         WHERE message -> ''payload'' -> ''email_data'' ->> ''token_hash'' = $1
         ORDER BY msg_id
         LIMIT 1'
    INTO v_payload
    USING 'hook-send-email-token-hash';

    RETURN v_payload;
END;
$$;

SELECT has_function(
    'public',
    'hook_send_email',
    ARRAY['jsonb'],
    'send email hook exists'
);

SELECT is(
    has_function_privilege(
        'anon', 'public.hook_send_email(jsonb)', 'execute'
    ),
    false,
    'anon cannot execute send email hook'
);

SELECT is(
    has_function_privilege(
        'authenticated', 'public.hook_send_email(jsonb)', 'execute'
    ),
    false,
    'authenticated cannot execute send email hook'
);

SELECT ok(
    NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'supabase_auth_admin'
    )
    OR has_function_privilege(
        'supabase_auth_admin',
        'public.hook_send_email(jsonb)',
        'execute'
    ),
    'supabase_auth_admin can execute send email hook when the role exists'
);

SELECT ok(
    pg_catalog.to_regclass('pgmq.q_send_email') IS NOT null,
    'send_email queue exists'
);

SELECT ok(
    (
        SELECT cron.target::jsonb ? 'send_email'
        FROM public.cron_tasks AS cron
        WHERE cron.name = 'high_frequency_queues'
    ),
    'high_frequency_queues drains send_email'
);

SELECT is(
    public.hook_send_email(
        '{"user":{},"email_data":{"email_action_type":"signup"}}'::jsonb
    ) -> 'error' ->> 'message',
    'Send email hook missing user email',
    'hook rejects missing email'
);

SELECT is(
    public.hook_send_email(
        '{"user":{"email":"hook-send-email@capgo.test"},"email_data":{}}'::jsonb
    ) -> 'error' ->> 'message',
    'Send email hook missing email_action_type',
    'hook rejects missing email_action_type'
);

SELECT is(
    public.hook_send_email(
        '{
      "user": {
        "id": "72000000-0000-4000-8000-000000000072",
        "email": "hook-send-email@capgo.test",
        "new_email": "hook-send-email-new@capgo.test"
      },
      "email_data": {
        "email_action_type": "email_change",
        "factor_type": "totp",
        "old_email": "hook-send-email-old@capgo.test",
        "redirect_to": "https://console.capgo.app",
        "site_url": "https://console.capgo.app",
        "token": "305805",
        "token_hash": "hook-send-email-token-hash"
      }
    }'::jsonb
    ),
    '{}'::jsonb,
    'hook enqueues a valid auth email'
);

SELECT is(
    pg_temp.send_email_payload() -> 'user' ->> 'email',
    'hook-send-email@capgo.test',
    'queued payload keeps the raw GoTrue user email'
);

SELECT is(
    pg_temp.send_email_payload() -> 'user' ->> 'new_email',
    'hook-send-email-new@capgo.test',
    'queued payload keeps the raw GoTrue user.new_email'
);

SELECT is(
    pg_temp.send_email_payload() -> 'email_data' ->> 'token',
    '305805',
    'queued payload keeps the raw GoTrue OTP token'
);

SELECT is(
    pg_temp.send_email_payload() -> 'email_data' ->> 'email_action_type',
    'email_change',
    'queued payload keeps the raw GoTrue email_action_type'
);

SELECT is(
    (
        SELECT message ->> 'function_name'
        FROM pgmq.q_send_email
        WHERE
            message -> 'payload' -> 'email_data' ->> 'token_hash'
            = 'hook-send-email-token-hash'
        ORDER BY msg_id
        LIMIT 1
    ),
    'send_email',
    'queued message targets send_email'
);

DELETE FROM pgmq.q_send_email
WHERE
    message -> 'payload' -> 'email_data' ->> 'token_hash'
    = 'hook-send-email-token-hash';

SELECT * FROM finish(); -- noqa: AM04
ROLLBACK;
