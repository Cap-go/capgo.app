-- Extensions required by a pg_dump schema clone (pg_cron stays on the primary postgres DB only).

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS hypopg WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS index_advisor WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS plpgsql_check WITH SCHEMA extensions;

-- pgmq is plain SQL since 20261126151718_pgmq_plain_sql: the dump carries its
-- types, functions and tables, so only the schema is created here.
CREATE SCHEMA IF NOT EXISTS pgmq;

CREATE SCHEMA IF NOT EXISTS vault;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;