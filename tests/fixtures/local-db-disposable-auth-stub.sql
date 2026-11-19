-- supabase/postgres only creates auth on the cluster's initial database; CREATE DATABASE
-- copies template1, which does not include auth. Disposable DBs run this before bootstrap.sql.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid,
  id uuid NOT NULL,
  aud character varying(255),
  role character varying(255),
  email character varying(255),
  encrypted_password character varying(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token character varying(255),
  confirmation_sent_at timestamptz,
  recovery_token character varying(255),
  recovery_sent_at timestamptz,
  email_change_token_new character varying(255),
  email_change character varying(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE SCHEMA IF NOT EXISTS extensions;