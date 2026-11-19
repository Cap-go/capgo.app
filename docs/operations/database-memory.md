# Investigating Supabase memory commitment

Supabase's **Acknowledgment** warning describes memory the kernel has promised
processes. It does not establish an application leak or an out-of-memory event.
Read commitment alongside available RAM, swap activity, OOM events, and the
operations executing during the same interval.

The warning starts at **50% of physical RAM plus 1 GiB**. The higher zones start
at 80% and 90% of physical RAM plus 1 GiB. These are estimates, not predictions of
when the database will crash. The kernel's `CommitLimit` is a separate metric.

Primary references:

- [Supabase memory commitment chart and warning text](https://github.com/supabase/supabase/blob/master/apps/studio/data/reports/database-charts.ts)
- [Supabase threshold calculation](https://github.com/supabase/supabase/blob/master/apps/studio/data/reports/database-charts.utils.ts)
- [Supabase Management API metrics endpoint](https://supabase.com/docs/reference/api/v1-scrape-project-metrics)
- [PostgreSQL memory settings](https://www.postgresql.org/docs/current/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-MEMORY)
- [PostgreSQL backend memory diagnostics](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)

## Capture the same interval

Use an existing Supabase access token supplied through the environment. The
reporter requests the project's metrics once, with a 30-second timeout. It does
not change settings, install extensions, reset statistics, or restart anything.

```sh
bun scripts/ops/supabase_memory_report.ts --project-ref "$SUPABASE_PROJECT_REF" > /tmp/memory-before.json
```

If a private Prometheus scrape already exists, generate the report offline:

```sh
bun scripts/ops/supabase_memory_report.ts --metrics-file /private/path/metrics.prom \
  --captured-at "$SCRAPE_CAPTURED_AT" > /tmp/memory-before.json
```

Set `SCRAPE_CAPTURED_AT` to the original scrape time in ISO format with a timezone.
If that time is unknown, omit the flag: `capturedAt` stays `null`; the reporter
does not substitute its own execution time for an older scrape.

The output omits project labels and unrelated metrics. Keep raw scrapes private:
they can contain identifiers or query text. Missing optional counters are `null`;
missing required gauges or multiple database-host series fail explicitly.

Capture catalog evidence alongside the host report with a current Supabase CLI:

```sh
bunx supabase db query --linked --project-ref "$SUPABASE_PROJECT_REF" \
  --file scripts/ops/inspect_supabase_memory.sql -o json > /tmp/memory-catalog-before.json
```

If the installed CLI does not support `db query --project-ref`, run the SQL with
`db query --linked` from a checkout already linked to the intended project, or
with `db query --db-url` against an explicitly selected database. Do not relink
a shared worktree just to collect a snapshot.

The SQL is catalog-only, read-only, and bounded by a five-second statement
timeout. It reports memory settings, grouped connection counts and ages,
shared allocations, database counters, the twenty query fingerprints with the
most temporary writes (then execution time), and this diagnostic session's memory
contexts. It never selects customer rows, SQL text, connection addresses,
application identifiers, or credentials. Query fingerprints can be resolved
privately through `pg_stat_statements`; they are not customer identifiers. Use a role with access to the relevant
statistics; do not broaden application-role grants for this tool.

Repeat both captures at the reported peak and after the candidate change under
comparable traffic. Save the exact alert start/end in UTC. Capture before a
statistics reset: a later `pg_stat_statements` snapshot cannot reconstruct an
older workload.

## Attribute a peak before changing limits

- Compare `committedBytes` with `availableBytes`; these measure different things.
  Do not subtract them or add process RSS values that count shared pages repeatedly.
- OOM kills and swap-in/out pages are counters **since host boot**. A nonzero
  counter does not prove activity during the alert. Compare timestamped samples
  with the same `hostBootTimeSeconds`. A reboot or counter reset invalidates the delta.
- Database temporary-file bytes are also cumulative. Compare samples from the
  same statistics interval. Disk spills identify operations to inspect, not the
  amount of live RAM consumed.
- `work_mem` is a per-operation allowance, not reserved RAM per connection.
  Multiple sorts, hashes, and parallel workers can multiply it. Lowering it can
  increase disk spills. `autovacuum_work_mem = -1` inherits `maintenance_work_mem`;
  that is a budget, not evidence that every worker allocated that amount.
- `current_session_contexts` covers only the diagnostic connection. It cannot
  attribute another backend's memory or all kernel commitments. Shared-buffer
  allocation is not the whole host footprint.

For a suspected backend, capture its memory contexts once using PostgreSQL's
built-in `pg_log_backend_memory_contexts(pid)` and inspect the resulting logs.
Select the intended PID from `pg_stat_activity` immediately before requesting
it. Avoid signaling all backends or scheduling repeated dumps. The return value
only confirms the signal was sent; background workers may not produce a dump.
Keep full logs private because context identifiers may include query text.
The context total is PostgreSQL allocator memory, not a process's complete
kernel commitment.

No new extension is required. If the available evidence cannot identify the
owner of a peak, preserve these snapshots and obtain process-level host
telemetry through Supabase support before changing global memory or connection
settings. Do not truncate tables, kill connections, shrink shared buffers, or
claim a reduction solely from this warning.

## Verify a reduction

Reproduce the affected operation with synthetic data at the observed size and
concurrency. Preserve output correctness and count errors. Interleave at least
five runs per side and report medians and ranges for peak memory, latency, and
spills. Then compare host snapshots during equivalent production traffic after
a separately approved deployment. A lower configured allowance or a faster
query alone does not prove reduced host commitment.
