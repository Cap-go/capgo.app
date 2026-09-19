-- Only reveal the email attached to the validated request actor. The actor
-- helper accepts JWTs and non-expired API keys, including hashed keys.
CREATE FUNCTION public.request_actor_email_adress()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.email::text
  FROM public.users AS u
  -- Evaluate the volatile actor helper once so the users PK bounds the lookup.
  WHERE u.id = (SELECT public.request_actor_user_id())
$$;

ALTER FUNCTION public.request_actor_email_adress() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.request_actor_email_adress() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_actor_email_adress() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.request_actor_email_adress() IS
  'Returns only the validated request actor email for CLI account whoami; no caller-supplied user ID is accepted.';
