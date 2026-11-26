#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"

# Keep the default order check for every migration except the five that
# landed after production had applied 20261117115240, and the no-op
# 20261120001201 follow-up to the restored 20261117152120 (capgo.app#4190
# renamed the prod-applied 152120, so 001201 sorts before newer prod versions).
if plan=$(supabase db push --db-url "$DATABASE_URL" --dry-run 2>&1); then
  exec supabase db push --db-url "$DATABASE_URL"
fi
printf '%s\n' "$plan" >&2

marker='Rerun the command with --include-all flag to apply these migrations:'
[[ "$plan" == *"$marker"* ]] || exit 1
found=false
while read -r migration; do
  case "$migration" in
    '') continue ;;
    supabase/migrations/20261117014348_console_request_fanout.sql|\
    supabase/migrations/20261117014945_stats_rollout_cron_load.sql|\
    supabase/migrations/20261117030227_app_storage_cleanup_passes.sql|\
    supabase/migrations/20261117031521_billing_profile_currency.sql|\
    supabase/migrations/20261117032322_simulator_idle_stop.sql|\
    supabase/migrations/20261120001201_storage_gb_hours_billing.sql)
      found=true ;;
    */20261117152120_storage_gb_hours_billing.sql)
      # A database that recorded the atomic 20261120001201 from #4190 but not
      # 20261117152120 already has the same schema (identical statements).
      # Replaying the non-atomic 152120 SQL there is not safe to do blindly,
      # so stop with the exact owner step instead of pushing.
      echo '::error::20261117152120 is pending but its schema came from 20261120001201 (#4190).' >&2
      echo '::error::After checking the schema, record it without replaying: supabase migration repair --db-url "$DATABASE_URL" --status applied 20261117152120' >&2
      exit 1 ;;
    *) exit 1 ;;
  esac
done <<< "${plan#*"$marker"}"
[[ "$found" == true ]] || exit 1
exec supabase db push --db-url "$DATABASE_URL" --include-all
