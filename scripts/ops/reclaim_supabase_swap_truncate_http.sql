-- Capgo-EU immediate reclaim — safe for Supabase SQL Editor.
-- Single statement. Run alone. No migration required.
-- Frees net._http_response bloat (~5GB on Capgo-EU when empty/stale).

TRUNCATE TABLE net._http_response;
