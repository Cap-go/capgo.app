-- Sign in with Apple was removed; drop its server-only auth tables.
DROP TABLE IF EXISTS public.apple_auth_token_uses;
DROP TABLE IF EXISTS public.apple_auth_attempts;
DROP TABLE IF EXISTS public.apple_auth_names;
