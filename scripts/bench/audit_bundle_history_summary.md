# Bundle channel removal query

The database query is faster in this local benchmark. This is not a production
latency measurement or a whole-page speedup. The production table has roughly
358,000 audit rows; the benchmark uses 360,000 synthetic rows and contains no
customer data.

| Database round trip | Before | After |
| --- | ---: | ---: |
| Median of 7 samples | 165.87 ms | 0.91 ms |
| Range | 161.94 to 173.98 ms | 0.61 to 1.33 ms |

The before query is compiled by the real console compiler and executes as
`authenticated` with the seeded owner's claims. The after query calls the real
migration's RPC with the same claims. Each returns the same two rows, in the same
order, and an exact count of two. A third matching row in an unreadable org stays
hidden. Every sampled and concurrent response is checked; any SQL error or
mismatch makes the script fail.

## Reproduce

Start and seed this worktree's local stack, then run:

```sh
bun run supabase:with-env -- sh -c 'AUDIT_BENCH_DATABASE_URL="$SUPABASE_DB_URL" bun scripts/bench/audit_bundle_history.mjs'
```

The script refuses non-local hosts. It copies the audit table's existing indexes,
adds only this migration's index/RPC to the after copy, and analyzes both copies.
The copied schema has a random name and is dropped in `finally`. Extra permission
fixtures roll back before the copied schema is committed for concurrent readers.

Recorded run: PostgreSQL 17.6, Bun 1.3.11, Docker on macOS, 18 host cores.
Host load was about 3 before the run, with other local stacks active. One warmup
per side precedes seven samples per side. The side order alternates each round.
Timing includes the SQL request, the permission helper, result serialization and
client decoding. Connection establishment and fixture setup are outside timing.
No profiler runs in the timed region.

The settings are unchanged on both sides: JIT on, 128 MiB shared buffers, 4 MiB
work_mem, random_page_cost 4. The dataset exceeds shared buffers. There is no
cache flush between runs, so PostgreSQL buffer reads can be served by the OS page
cache. These are not cold-disk measurements.

## Why it changes

JSON extraction is not leakproof, so RLS prevents the original table query from
using the JSON expressions as index conditions. An index alone still scans the
channel updates. The new authenticated-only SECURITY DEFINER RPC computes the
same allowed-org set as the table's SELECT policy once per call, then applies
that set in both the count and page queries. It preserves audit visibility for
historical app owners and deleted apps without exposing other orgs.

The partial index contains 98,251 version-changing channel updates
and occupies 6.22 MiB in this dataset. Its leading keys are
`old_record->>'app_id'` and `old_record->>'version'`, followed by `created_at`.
Both required equality filters remain index conditions in custom and generic
plans. Counts still scan the matching bundle's history, rather than all channel
updates. Output is capped at 1,000 rows, matching the existing console ceiling.

Separate EXPLAIN ANALYZE/BUFFERS runs show the cause of the improvement:

- Before: two bitmap heap scans filter 98,249 candidates each; 90,230 shared
  buffer accesses in total, including 90,172 buffer reads.
- After: each index scan visits three matching entries and rejects the one
  unreadable org; 11 shared buffer accesses in the profiled function body.
- The forced generic plan also uses both JSON equality keys and touches 10
  shared buffers. It sorts only the matching page candidates.

The raw JSON contains both full plans. The after body is explained separately as
its table-owning definer, with the same allowed-org array. Its plan timing omits
the permission-helper call. The headline round-trip timing includes that call.
The old query is limited by heap reads and JSON filtering; the new query spends
most of its remaining time on permission resolution and the database round trip.

## Scalability and permissions

Execution model: the console calls the RPC once per bundle-history fetch.
`audit_logs_allowed_orgs()` runs once per RPC, starting from caller-scoped role
bindings. It uses `role_bindings_principal_scope_idx`,
`role_bindings_principal_org_idx` and `idx_group_members_user_id_group_id`.
The audit table is reached only through the indexed app/bundle pair. No policy,
existing function grant, public plugin path or published CLI contract changes.
Only `authenticated` can execute the new function; it has an empty search path
and an explicit owner and ACL.

Read-only production catalog estimates on 2026-10-29, used to size the synthetic
fixture and assess the existing permission helper:

| Table | Estimated rows |
| --- | ---: |
| `apikeys` | 26,080 |
| `audit_logs` | 358,179 |
| `group_members` | 65 |
| `groups` | 83 |
| `permissions` | 39 |
| `role_bindings` | 45,197 |
| `role_permissions` | 181 |
| `roles` | 20 |
| `users` | 10,028 |

Validation covers the required callers and bounds:

- Anonymous calls without a key, with an invalid key, and with a valid org-wide
  audit key all fail EXECUTE with 42501 on this new console-only RPC. The valid
  key's existing table-policy audit access is separately verified.
- An authenticated caller without audit rights gets an empty page and count.
- A caller with 34 allowed orgs gets the same two rows;
  the additional permission bindings are caller-scoped.
- Eight simultaneous unfiltered RPC calls all fail with 42883 because app and
  bundle arguments are required. The unrelated org query completed in
  2.60 ms. This separate probe used the real public RPC; no audit rows
  can be visited when function resolution rejects the missing arguments.
  Unknown app/bundle pairs return an empty page through indexed equality filters.
- Eight concurrent requests all return the expected rows/counts. One burst per
  side took 586.8 to 586.8 ms before and
  13.2 to 13.2 ms after. The concurrent unrelated
  `SELECT id FROM public.orgs LIMIT 1` completed in
  1.40 ms and 0.74 ms respectively.
  These single bursts are concurrency checks, not repeated latency estimates.

The console API integration test also exercises the real HTTP route, including
both sort directions, channel filtering and exact counts with a hidden org row.
The benchmark does not measure browser rendering, API authentication or network
latency outside the local database connection. Production performance must be
measured after deployment. The migration builds a normal index and takes the
usual write lock during that build; this work did not apply it to production.
