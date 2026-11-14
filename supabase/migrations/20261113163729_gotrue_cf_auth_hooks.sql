-- Auth PR 2 of 3: let our self-hosted GoTrue (role gotrue_cf) call the same
-- Postgres auth hooks as Supabase Auth. Both are SECURITY DEFINER owned by
-- postgres, so they still run as postgres; gotrue_cf only needs to call them.
GRANT USAGE ON SCHEMA public TO gotrue_cf;
GRANT EXECUTE ON FUNCTION public.hook_send_email(jsonb) TO gotrue_cf;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO gotrue_cf;
