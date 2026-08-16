BEGIN;

SELECT plan(6);

SELECT tests.create_supabase_user(
  'mfa_session_split_with_mfa',
  'mfa-session-split-with-mfa@test.local'
);
SELECT tests.create_supabase_user(
  'mfa_session_split_without_mfa',
  'mfa-session-split-without-mfa@test.local'
);
SELECT tests.mark_email_otp_verified('mfa_session_split_with_mfa');

INSERT INTO auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  created_at,
  updated_at
)
VALUES (
  gen_random_uuid(),
  tests.get_supabase_uid('mfa_session_split_with_mfa'),
  'Test TOTP',
  'totp'::auth.factor_type,
  'verified'::auth.factor_status,
  NOW(),
  NOW()
);

SELECT tests.authenticate_as('mfa_session_split_without_mfa');
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', tests.get_supabase_uid('mfa_session_split_without_mfa'),
    'email', 'mfa-session-split-without-mfa@test.local',
    'aal', 'aal1',
    'amr', '[]'::jsonb
  )::text,
  true
);
SELECT is(
  public.verify_mfa(),
  true,
  'verify_mfa allows aal1 when the user has no verified MFA factor'
);
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('mfa_session_split_with_mfa');
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', tests.get_supabase_uid('mfa_session_split_with_mfa'),
    'email', 'mfa-session-split-with-mfa@test.local',
    'aal', 'aal1',
    'amr', jsonb_build_array(jsonb_build_object('method', 'password'))
  )::text,
  true
);
SELECT is(
  public.verify_mfa(),
  false,
  'verify_mfa rejects aal1 when the user has a verified MFA factor'
);
SELECT is(
  public.verify_email_otp_auth(),
  false,
  'verify_email_otp_auth rejects non-OTP amr methods'
);
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('mfa_session_split_with_mfa');
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', tests.get_supabase_uid('mfa_session_split_with_mfa'),
    'email', 'mfa-session-split-with-mfa@test.local',
    'aal', 'aal1',
    'amr', jsonb_build_array(jsonb_build_object('method', 'otp'))
  )::text,
  true
);
SELECT is(
  public.verify_mfa(),
  false,
  'verify_mfa rejects aal1 OTP first-factor sessions when the user has MFA'
);
SELECT is(
  public.verify_email_otp_auth(),
  true,
  'verify_email_otp_auth recognizes OTP first-factor sessions separately'
);
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('mfa_session_split_with_mfa');
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', tests.get_supabase_uid('mfa_session_split_with_mfa'),
    'email', 'mfa-session-split-with-mfa@test.local',
    'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'otp'))
  )::text,
  true
);
SELECT is(
  public.verify_mfa(),
  true,
  'verify_mfa allows aal2 when the user has a verified MFA factor'
);
SELECT tests.clear_authentication();

SELECT * FROM finish();

ROLLBACK;
