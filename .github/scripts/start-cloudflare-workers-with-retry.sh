#!/usr/bin/env bash

set -euo pipefail

max_attempts="${CLOUDFLARE_WORKERS_START_MAX_ATTEMPTS:-2}"
worker_port_offset="${CLOUDFLARE_WORKER_PORT_OFFSET:-0}"
log_path="${CLOUDFLARE_WORKERS_LOG_PATH:-${RUNNER_TEMP:-/tmp}/cloudflare-workers.log}"
wait_timeout_ms="${CLOUDFLARE_WORKERS_WAIT_TIMEOUT_MS:-180000}"
worker_pids=()

stop_worker_pid() {
  local pid="$1"
  if [[ -z "${pid}" ]]; then
    return
  fi
  kill "${pid}" 2>/dev/null || true
  pkill -P "${pid}" 2>/dev/null || true
}

stop_all_worker_pids() {
  local pid
  for pid in "${worker_pids[@]}"; do
    stop_worker_pid "${pid}"
  done
}

export BACKGROUND_SERVICE_NAME="${BACKGROUND_SERVICE_NAME:-Cloudflare Workers}"
export BACKGROUND_RUN_COMMAND="${BACKGROUND_RUN_COMMAND:-$'chmod +x scripts/start-cloudflare-workers.sh\nexec ./scripts/start-cloudflare-workers.sh'}"
export BACKGROUND_LOG_PATH="${log_path}"
export BACKGROUND_WAIT_TIMEOUT_MS="${wait_timeout_ms}"
export BACKGROUND_TAIL_LINES="${BACKGROUND_TAIL_LINES:-400}"
export BACKGROUND_WAIT_ON="http-get://127.0.0.1:$((8787 + worker_port_offset))/ok
http-get://127.0.0.1:$((8788 + worker_port_offset))/ok
http-get://127.0.0.1:$((8789 + worker_port_offset))/ok"

for attempt in $(seq 1 "${max_attempts}"); do
  if bash .github/scripts/start-background-service.sh; then
    exit 0
  else
    exit_code=$?
    if [[ -n "${GITHUB_OUTPUT:-}" ]] && [[ -f "${GITHUB_OUTPUT}" ]]; then
      latest_pid="$(grep '^pid=' "${GITHUB_OUTPUT}" | tail -1 | cut -d= -f2- || true)"
      if [[ -n "${latest_pid}" ]]; then
        worker_pids+=("${latest_pid}")
        stop_worker_pid "${latest_pid}"
      fi
    fi
    echo "Cloudflare Workers failed to become ready with exit ${exit_code} (attempt ${attempt}/${max_attempts})" >&2
    if [ "${attempt}" -eq "${max_attempts}" ]; then
      stop_all_worker_pids
      exit "${exit_code}"
    fi
    sleep_seconds=$((attempt * 10))
    echo "Retrying Cloudflare Workers startup in ${sleep_seconds}s..." >&2
    sleep "${sleep_seconds}"
  fi
done
