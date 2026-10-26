# Queue engine benchmark: pgmq vs pgque

Replays Capgo's production queue load (derived with `prod_load.sql`) against
pgmq and pgque in an isolated Postgres 17 container, and records DB-side cost:
container CPU, WAL bytes, tuple writes, dead tuples, vacuums, statement latency
and consumer poll time.

Findings and the migration analysis are in
[`docs/operations/pgque-vs-pgmq.md`](../../../docs/operations/pgque-vs-pgmq.md).

| File | Purpose |
|---|---|
| `prod_load.sql` | Read-only prod queries behind the load model |
| `setup.sql` | Queue model (rates, bursts, payloads, failure rates) and both consumers |
| `reset_engines.sql` | Recreates the queues on both engines before each run |
| `snapshot.sql` | Cost counters captured before and after each run |
| `start_container.sh` | Starts the container and installs pgmq, pgque and the bench schema |
| `bench.sh` | One run: `[TICK_MS=1000] bench.sh <pgmq\|pgque> <load_x> <seconds> [longtx]` |
| `run_matrix.sh` | Full matrix used for the report |
| `summarize.py` | Builds the markdown table and `summary.json` from `runs/` |
| `results.json` | Results committed with the report |

Requirements: Docker, plus PG17 `psql` and `pgbench` on `PATH`. Set
`BENCH_DB_URL` and `BENCH_CONTAINER` to point at a different database.
