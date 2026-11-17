-- pgTAP assertions intentionally use SQL statements returning function results.
-- noqa: disable=LT05,LT09,AM04
BEGIN;
SELECT plan(12);
SELECT
    has_table('public', 'invoice_email_preferences', 'invoice preferences exist');
SELECT
    has_table('public', 'invoice_email_deliveries', 'invoice delivery outbox exists');
SELECT
    ok((
        SELECT relrowsecurity FROM pg_class
        WHERE oid = 'public.invoice_email_preferences'::regclass
    ), 'preferences have RLS');
SELECT
    ok((
        SELECT relrowsecurity FROM pg_class
        WHERE oid = 'public.invoice_email_deliveries'::regclass
    ), 'delivery outbox has RLS');
SELECT
    is(has_table_privilege('authenticated', 'public.invoice_email_preferences', 'INSERT,UPDATE'), false, 'settings require the authorized billing API');
SELECT
    is(has_table_privilege('anon', 'public.invoice_email_deliveries', 'SELECT,INSERT,UPDATE'), false, 'anonymous callers cannot read or enqueue invoices');
SELECT
    is(has_table_privilege('authenticated', 'public.invoice_email_deliveries', 'SELECT,INSERT,UPDATE'), false, 'members cannot access another org delivery outbox directly');
SELECT
    is(has_table_privilege('service_role', 'public.invoice_email_deliveries', 'SELECT,INSERT,UPDATE'), true, 'service can deliver invoices');
SELECT
    col_default_is('public', 'invoice_email_preferences', 'enabled', 'true', 'invoice emails default on');
SELECT
    throws_ok($$INSERT INTO public.invoice_email_preferences(org_id, recipients) VALUES (gen_random_uuid(), ARRAY['a','b','c','d','e','f'])$$, '23514', null, 'six recipients are rejected by the database');
SELECT
    throws_ok($$INSERT INTO public.invoice_email_preferences(org_id, recipients) VALUES (gen_random_uuid(), ARRAY[NULL]::text[])$$, '23514', null, 'null recipients are rejected');
SELECT
    col_is_unique('public', 'invoice_email_deliveries', ARRAY['billing_account', 'invoice_id'], 'one delivery decision per invoice and Stripe entity');
SELECT * FROM finish();
ROLLBACK;
