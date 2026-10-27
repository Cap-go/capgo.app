-- deploy_history is scoped by current_user_member_org_ids(). A pending
-- invitation or an org_users row without an active role binding must not
-- grant read access; an accepted member keeps it.
BEGIN;

SELECT plan(8);

SELECT tests.create_supabase_user(
    'deploy_history_invitee', 'deploy-history-invitee@test.local'
);
SELECT tests.create_supabase_user(
    'deploy_history_unbound', 'deploy-history-unbound@test.local'
);

SELECT tests.authenticate_as_service_role();
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
(
    tests.get_supabase_uid('deploy_history_invitee'),
    'deploy-history-invitee@test.local',
    now(),
    now()
),
(
    tests.get_supabase_uid('deploy_history_unbound'),
    'deploy-history-unbound@test.local',
    now(),
    now()
)
ON CONFLICT (id) DO NOTHING;

-- A non-invite org_users row with no role binding at all (stale membership).
INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
VALUES (
    tests.get_supabase_uid('deploy_history_unbound'),
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    public.rbac_role_org_member(),
    false
);

RESET ROLE;
SELECT tests.clear_authentication();

-- The org owner invites an existing user through the regular RBAC flow.
SELECT tests.authenticate_as('test_user');

SELECT is(
    public.invite_user_to_org_rbac(
        'deploy-history-invitee@test.local',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
        public.rbac_role_org_member()
    )::text,
    'OK',
    'org owner invites an existing user'
);

SELECT ok(
    (
        SELECT count(*) > 0
        FROM public.deploy_history
        WHERE owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
    ),
    'org owner can read the org deploy history'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.org_users
        WHERE
            user_id = tests.get_supabase_uid('deploy_history_invitee')
            AND org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
            AND is_invite IS true
    ),
    1::bigint,
    'invitee has a pending org_users invitation row'
);

SELECT tests.clear_authentication();

-- Pending invitee: org_users row exists with is_invite = true.
SELECT tests.authenticate_as('deploy_history_invitee');

SELECT ok(
    NOT (
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid
        = any(public.current_user_member_org_ids())
    ),
    'pending invitation is not returned as org membership'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.deploy_history
        WHERE owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
    ),
    0::bigint,
    'pending invitee cannot read the org deploy history'
);

SELECT is(
    public.accept_invitation_to_org(
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
    )::text,
    'OK',
    'invitee accepts the invitation'
);

SELECT ok(
    (
        SELECT count(*) > 0
        FROM public.deploy_history
        WHERE owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
    ),
    'accepted member can read the org deploy history'
);

SELECT tests.clear_authentication();

-- org_users row without any active role binding grants nothing.
SELECT tests.authenticate_as('deploy_history_unbound');

SELECT is(
    (
        SELECT count(*)
        FROM public.deploy_history
        WHERE owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
    ),
    0::bigint,
    'org_users row without an active role binding cannot read deploy history'
);

SELECT tests.clear_authentication();

SELECT * FROM finish();

ROLLBACK;
