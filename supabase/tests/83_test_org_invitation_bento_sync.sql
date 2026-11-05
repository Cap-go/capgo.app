SET default_transaction_isolation = 'repeatable read';
BEGIN;

SELECT plan(28);

SELECT hasnt_table(
    'public', 'bento_event_dispatches',
    'the Bento dispatch ledger is removed'
);
SELECT hasnt_table(
    'public', 'bento_evaluation_runs',
    'the Bento evaluation run table is removed'
);
SELECT has_column(
    'public', 'org_invitation_email_requests', 'bento_synced_at',
    'invitation requests record when Bento accepted org:invite_sent'
);
SELECT has_column(
    'public', 'org_invitation_email_requests', 'bento_email',
    'invitation requests record the Bento subscriber address'
);
SELECT has_index(
    'public', 'org_invitation_email_requests',
    'org_invitation_email_requests_bento_email_idx',
    'open invitations are looked up by Bento address through an index'
);
SELECT ok(
    (
        SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=""'])
        FROM pg_catalog.pg_proc
        WHERE oid IN (
            'public.trigger_queue_org_invitation_bento_sync()'::regprocedure,
            'public.queue_org_invitation_bento_sync(text)'::regprocedure
        )
    ),
    'the Bento sync functions have definer security and an empty search path'
);
SELECT is(
    pg_catalog.has_function_privilege(
        'authenticated',
        'public.queue_org_invitation_bento_sync(text)',
        'EXECUTE'
    ), false, 'authenticated callers cannot queue Bento syncs directly'
);
SELECT is(
    pg_catalog.has_function_privilege(
        'anon',
        'public.queue_org_invitation_bento_sync(text)',
        'EXECUTE'
    ), false, 'anonymous callers cannot queue Bento syncs directly'
);
SELECT is(
    pg_catalog.has_function_privilege(
        'authenticated',
        'public.trigger_queue_org_invitation_bento_sync()',
        'EXECUTE'
    ), false, 'authenticated callers cannot execute the sync trigger directly'
);
SELECT is(
    pg_catalog.has_function_privilege(
        'anon',
        'public.trigger_queue_org_invitation_bento_sync()',
        'EXECUTE'
    ), false, 'anonymous callers cannot execute the sync trigger directly'
);

CREATE FUNCTION pg_temp.bento_syncs(p_email text)
RETURNS bigint
LANGUAGE sql
SET search_path = ''
AS $$
    SELECT count(*) FROM pgmq.q_send_email
    WHERE message -> 'payload' -> 'org_invitation_bento_sync'
        = pg_catalog.jsonb_build_object('email', p_email)
      AND message ->> 'function_name' = 'send_email'
      AND message ->> 'function_type' = 'cloudflare';
$$;

CREATE FUNCTION pg_temp.all_bento_syncs()
RETURNS bigint
LANGUAGE sql
SET search_path = ''
AS $$
    SELECT count(*) FROM pgmq.q_send_email
    WHERE message -> 'payload' ? 'org_invitation_bento_sync';
$$;

SELECT tests.create_supabase_user(
    'bento_sync_actor', 'bento-sync-actor@example.com'
);
SELECT tests.create_supabase_user(
    'bento_sync_synced', 'bento-sync-synced@example.com'
);
SELECT tests.create_supabase_user(
    'bento_sync_unsynced', 'bento-sync-unsynced@example.com'
);
SET LOCAL "request.jwt.claim.role" = 'service_role';

INSERT INTO public.users (id, email)
VALUES
(tests.get_supabase_uid('bento_sync_actor'), 'bento-sync-actor@example.com'),
(tests.get_supabase_uid('bento_sync_synced'), 'bento-sync-synced@example.com'),
(
    tests.get_supabase_uid('bento_sync_unsynced'),
    'bento-sync-unsynced@example.com'
);

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
    '83000000-0000-4000-8000-000000000001',
    tests.get_supabase_uid('bento_sync_actor'),
    'Invitation Bento sync test', 'bento-sync-org@example.com'
);

SELECT pg_catalog.set_config(
    'request.jwt.claim.sub',
    tests.get_supabase_uid('bento_sync_actor')::text,
    true
);
INSERT INTO public.org_users (id, org_id, user_id, rbac_role_name, is_invite)
VALUES
(
    830001, '83000000-0000-4000-8000-000000000001',
    tests.get_supabase_uid('bento_sync_synced'),
    public.rbac_role_org_member(), true
),
(
    830002, '83000000-0000-4000-8000-000000000001',
    tests.get_supabase_uid('bento_sync_unsynced'),
    public.rbac_role_org_member(), true
);

INSERT INTO public.tmp_users (
    id, email, org_id, first_name, last_name, invite_magic_string
)
VALUES
(
    830001, 'bento-sync-rescind@example.com',
    '83000000-0000-4000-8000-000000000001',
    'Rescind', 'Me', 'bento-sync-token-1'
),
(
    830002, 'bento-sync-accept@example.com',
    '83000000-0000-4000-8000-000000000001',
    'Accept', 'Me', 'bento-sync-token-2'
),
(
    830003, 'bento-sync-unsent@example.com',
    '83000000-0000-4000-8000-000000000001',
    'Unsent', 'Invite', 'bento-sync-token-3'
),
(
    830004, 'bento-sync-resend@example.com',
    '83000000-0000-4000-8000-000000000001',
    'Resend', 'Me', 'bento-sync-token-4'
);

-- Simulate delivered invitations that Bento already tracks. The stored
-- address deliberately differs from the account email to prove syncs target
-- the address Bento received, not the current one.
UPDATE public.org_invitation_email_requests
SET
    sent_at = pg_catalog.now(),
    bento_synced_at = pg_catalog.now(),
    bento_email = 'bento-sync-original@example.com'
WHERE org_user_id = 830001;
UPDATE public.org_invitation_email_requests AS request
SET
    sent_at = pg_catalog.now(),
    bento_synced_at = pg_catalog.now(),
    bento_email = invitation.email
FROM public.tmp_users AS invitation
WHERE
    invitation.id = request.tmp_user_id
    AND invitation.id IN (830001, 830002, 830004);

SET LOCAL lock_timeout = '5s';
UPDATE public.org_users SET is_invite = false
WHERE id = 830001;
SELECT is(
    pg_catalog.current_setting('lock_timeout'), '5s',
    'a successful existing-user close restores the caller lock timeout'
);
SELECT is(
    pg_temp.bento_syncs('bento-sync-original@example.com'),
    1::bigint,
    'accepting a Bento-tracked existing-user invite syncs the address Bento got'
);
SELECT is(
    pg_temp.bento_syncs('bento-sync-synced@example.com'),
    0::bigint, 'the current account email is not used for the sync'
);

CREATE TEMPORARY TABLE bento_sync_baseline AS
SELECT pg_temp.all_bento_syncs() AS count;
DELETE FROM public.org_users
WHERE id = 830002;
SELECT is(
    pg_temp.all_bento_syncs(),
    (SELECT count FROM pg_temp.bento_sync_baseline),
    'removing an invite Bento never saw queues no sync for any address'
);

SET LOCAL lock_timeout = '50ms';
UPDATE public.tmp_users SET cancelled_at = pg_catalog.now()
WHERE id = 830001;
SELECT is(
    pg_catalog.current_setting('lock_timeout'), '50ms',
    'a successful new-user close preserves a stricter caller lock timeout'
);
SET LOCAL lock_timeout = '0';
SELECT is(
    pg_temp.bento_syncs('bento-sync-rescind@example.com'),
    1::bigint,
    'rescinding a Bento-tracked new-user invite queues one field sync'
);
UPDATE public.tmp_users SET cancelled_at = pg_catalog.now()
WHERE id = 830001;
SELECT is(
    pg_temp.bento_syncs('bento-sync-rescind@example.com'),
    1::bigint, 'touching an already-cancelled invite queues nothing more'
);

-- Simulate the cancellation sync exhausting its queue budget before deletion.
DELETE FROM pgmq.q_send_email
WHERE
    message -> 'payload' -> 'org_invitation_bento_sync' ->> 'email'
    = 'bento-sync-rescind@example.com';
DELETE FROM public.tmp_users
WHERE id = 830001;
SELECT is(
    pg_temp.bento_syncs('bento-sync-rescind@example.com'),
    1::bigint, 'deletion retries a failed cancellation sync'
);

DELETE FROM public.tmp_users
WHERE id = 830002;
SELECT is(
    pg_temp.bento_syncs('bento-sync-accept@example.com'),
    1::bigint,
    'deleting a tracked new-user invite queues one field sync'
);
SELECT is(
    (
        SELECT count(*) FROM public.org_invitation_email_requests
        WHERE tmp_user_id = 830002
    ),
    0::bigint, 'the request row still cascades after the sync is queued'
);

UPDATE pg_temp.bento_sync_baseline SET count = pg_temp.all_bento_syncs();
DELETE FROM public.tmp_users
WHERE id = 830003;
SELECT is(
    pg_temp.all_bento_syncs(),
    (SELECT count FROM pg_temp.bento_sync_baseline),
    'deleting an undelivered new-user invite queues no sync for any address'
);

-- A resend starts a new generation, which must start its own Bento flow,
-- and the replaced generation must leave the field right away.
UPDATE public.org_invitation_email_requests
SET requested_at = pg_catalog.now() - interval '6 minutes'
WHERE tmp_user_id = 830004;
UPDATE public.tmp_users SET invite_magic_string = 'bento-sync-token-4-rotated'
WHERE id = 830004;
SELECT is(
    (
        SELECT row(sent_at, bento_synced_at, bento_email)::text
        FROM public.org_invitation_email_requests
        WHERE tmp_user_id = 830004
    ),
    '(,,)', 'a resend clears the delivery and Bento markers'
);
SELECT is(
    pg_temp.bento_syncs('bento-sync-resend@example.com'),
    1::bigint, 'a resend queues a sync that drops the replaced generation'
);
UPDATE public.org_invitation_email_requests
SET requested_at = pg_catalog.now() - interval '6 minutes'
WHERE tmp_user_id = 830004;
UPDATE public.tmp_users SET invite_magic_string = 'bento-sync-token-4-again'
WHERE id = 830004;
SELECT is(
    pg_temp.bento_syncs('bento-sync-resend@example.com'),
    1::bigint, 'a resend of a not-yet-enrolled generation queues no sync'
);

CREATE FUNCTION pg_temp.rollback_bento_close()
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    UPDATE public.org_invitation_email_requests
    SET bento_email = 'bento-sync-rollback@example.com'
    WHERE tmp_user_id = 830004;
    DELETE FROM public.tmp_users WHERE id = 830004;
    RAISE EXCEPTION 'BENTO_SYNC_TEST_ROLLBACK';
END;
$$;
SELECT throws_ok(
    $$SELECT pg_temp.rollback_bento_close()$$,
    'P0001', 'BENTO_SYNC_TEST_ROLLBACK',
    'a failed close rolls back'
);
SELECT is(
    pg_temp.bento_syncs('bento-sync-rollback@example.com'),
    0::bigint, 'a rolled-back close leaves no sync job'
);
SELECT is(
    (
        SELECT count(*) FROM public.tmp_users
        WHERE id = 830004
    ),
    1::bigint, 'a rolled-back close keeps the invitation'
);
SELECT ok(
    NOT EXISTS (
        SELECT 1 FROM pgmq.list_queues()
        WHERE queue_name LIKE '%bento%'
    ),
    'Bento sync uses the existing send_email queue'
);

SELECT tests.clear_authentication();
SELECT * FROM finish(); -- noqa: AM04
ROLLBACK;
RESET default_transaction_isolation;
