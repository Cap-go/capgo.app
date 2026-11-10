#!/usr/bin/env bash
# Wrangler dev refuses a compatibility_date from wrangler.jsonc when that date is
# still in the future (today is measured in UTC). Deploy still uses the date in
# wrangler.jsonc. Override here so local dev and CI can run before that day.
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    --compatibility-date|--compatibility-date=*)
      exec bunx wrangler dev "$@"
      ;;
    esac
done
today_utc="$(date -u +%Y-%m-%d)"
# Bun miniflare caps supported dates below production; pick min(today, max) unless WRANGLER_DEV_COMPATIBILITY_DATE is set.
max_supported="${WRANGLER_DEV_MAX_COMPATIBILITY_DATE:-2026-11-11}"
if [ -n "${WRANGLER_DEV_COMPATIBILITY_DATE:-}" ]; then
  compat="$WRANGLER_DEV_COMPATIBILITY_DATE"
else
  compat="$(printf '%s\n%s\n' "$today_utc" "$max_supported" | sort -V | head -n1)"
fi
exec bunx wrangler dev --compatibility-date "${compat}" "$@"
