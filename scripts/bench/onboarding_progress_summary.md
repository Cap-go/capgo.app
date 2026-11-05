# Onboarding progress permission benchmark

The change removes duplicate `app.read` database queries within an onboarding
request. It does not establish a statistically reliable latency improvement:
local timings vary substantially, so the timing result is **inconclusive**.

The route authorizes `app.read` before loading the requested app. Channel and
bundle observations previously repeated that same check. The observations now
reuse the route's authorization for that request. Every new request still checks
access, observations still run under caller RLS, and device/log permissions and
locked write checks retain their separate authorization.

## Reproduce

Start a seeded local Supabase stack, install dependencies, then run:

```sh
bun scripts/supabase-worktree.ts with-env bun scripts/bench/onboarding_progress.mjs ebbac171cf1662b200ca2349c52f666bbbc16280
```

The harness loads the baseline handler from that git commit and the working-tree
handler into the same Bun process. Both use the real JWT middleware, local Auth,
Postgres connections, SQL permission function and caller RLS. The temporary
handler modules and isolated fixture app are removed after the run. The existing
seed user's organization is only used as the parent of the new fixture app.

Only loopback Auth and database services are accepted. The harness does not
reset database statistics or use production credentials or data. The JSON
report contains aggregate timings and query counts, without tokens or fixture
identities. Application logs precede the report on standard output.

## Measured work

| Request | `app.read` queries before | After |
| --- | ---: | ---: |
| Channel poll (`N=0`) | 2 | 1 |
| Bundle poll (`N=2`) | 2 | 1 |
| Initial load | 3 | 1 |

Both initial-load variants also execute one explicit `app.read_devices` check and
one `app.read_logs` check. These checks are not skipped by the change. The harness
counts actual node-postgres query executions, including the permission bound as
the first parameter; it does not infer query counts from the source.

All 570 authenticated requests (540 measured plus 30 warmups) returned HTTP 200,
identical expected response bodies and the expected query counts. There were
zero failures. A subsequent unauthenticated request is rejected with HTTP 401.
The fixture app has no channels, published bundles, devices or update logs, so
its observations do not need progress writes. The benchmark covers the read
path; write behavior is covered by the endpoint regression suite.

## Local response timings

Bun 1.3.11 on macOS arm64, against the worktree's local Docker Supabase stack.
Each entry is the median of nine batch averages, with ten requests per batch.
Before/after requests alternate, and their order reverses on every pair and
sample. Five requests per side warm each scenario before measurement.

| Request | Before, median (range) | After, median (range) |
| --- | ---: | ---: |
| Channel poll | 26.67 ms (21.61–120.48 ms) | 23.19 ms (18.81–148.98 ms) |
| Bundle poll | 42.43 ms (24.55–72.98 ms) | 38.30 ms (21.44–69.38 ms) |
| Initial load | 32.55 ms (28.08–47.29 ms) | 29.18 ms (24.61–51.59 ms) |

The timed region includes the handler, authentication, database operations and
JSON response parsing. It excludes module loading, fixture setup and login. The
caller invokes Hono directly, so there is no inbound HTTP network hop. The local
stats/device readers use Postgres, whereas production can use analytics bindings.
Production Worker/Hyperdrive behavior and production data sizes are not measured.

The machine was shared with other local Docker workloads. Variation is larger
than the median differences, and the latency limiter was not isolated; no
percentage speedup or production latency claim is supported by these numbers.
The demonstrated improvement is one fewer permission round trip per channel or
bundle poll, and two fewer on an initial load.

Raw samples and counted permission queries are in
[`onboarding_progress_results.json`](onboarding_progress_results.json).
