-- Auth PR 1 of 3: database role and empty schema for our self-hosted GoTrue.
-- GoTrue creates its own tables in auth_cf when it first starts (PR 2).
-- This migration copies no accounts and changes no production auth path.

-- Pre-hashed SCRAM-SHA-256 verifier (Postgres defaults: 4096 iterations, 16-byte salt).
-- The plaintext password is not in the repository.
CREATE ROLE gotrue_cf WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:R2M0YsXSa6hTg9xt7j+VDg==$hyN0E9w1eqVdueBTHDwKrbI+3blOyko8NKA+b6mgJ7A=:WpfCXMAEVzzrbzgihLYh/tzb3PzkHAxG1P3WY6Jka9M=';

-- postgres is not a superuser on Supabase, so it must be a member of gotrue_cf
-- to create a schema owned by it. The membership also lets postgres reach
-- GoTrue's tables later, when the accounts are copied (PR 3).
GRANT gotrue_cf TO postgres;

CREATE SCHEMA auth_cf AUTHORIZATION gotrue_cf;

-- GoTrue queries its tables unqualified, like supabase_auth_admin with auth.
ALTER ROLE gotrue_cf SET search_path = auth_cf;
