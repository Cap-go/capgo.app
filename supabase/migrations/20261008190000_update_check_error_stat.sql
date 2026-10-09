-- Updater plugins report action=update_check_error when the update check itself
-- fails on the device (offline, timeout, unreadable response, local 429 block).
-- Nothing was downloaded, so it must not be counted as a bundle failure: the
-- name intentionally does not end with "_fail".
ALTER TYPE public.stats_action ADD VALUE IF NOT EXISTS 'update_check_error';
