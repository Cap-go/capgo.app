#!/usr/bin/env bash
set -euo pipefail

# Keep the default order check for every migration except the five that
# landed after production had applied 20261117115240.
if plan=$(supabase db push --dry-run 2>&1); then
  exec supabase db push
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
    supabase/migrations/20261117032322_simulator_idle_stop.sql)
      found=true ;;
    *) exit 1 ;;
  esac
done <<< "${plan#*"$marker"}"
[[ "$found" == true ]] || exit 1
exec supabase db push --include-all
