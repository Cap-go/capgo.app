#!/usr/bin/env bash
# Wrangler dev refuses a compatibility_date from wrangler.jsonc when that date is
# still in the future (today is measured in UTC). Deploy still uses the date in
# wrangler.jsonc. Override here so local dev and CI can run before that day.
set -euo pipefail
compat="${WRANGLER_DEV_COMPATIBILITY_DATE:-$(date -u +%Y-%m-%d)}"
exec bunx wrangler dev --compatibility-date "${compat}" "$@"
