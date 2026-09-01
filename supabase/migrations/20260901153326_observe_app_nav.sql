-- SPA / Capacitor navigation events for Observe (no Expo Router required).
-- Plugins report action=app_nav with metadata.route (or path) and optional duration_ms.
ALTER TYPE public.stats_action ADD VALUE IF NOT EXISTS 'app_nav';
