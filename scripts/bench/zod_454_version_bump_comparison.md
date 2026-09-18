# Zod 4.4.3 → 4.5.4 version-only benchmark (no z.compile)

Measured on the same VM with existing validation paths only: production `.is`
predicate, `zod-compiler` AOT, and Zod runtime `safeParse`. Does **not** use
Zod 4.5 `z.compile()` — plugin hot paths keep the existing `zod-compiler` flow.

## Summary

| Area | 4.4.3 | 4.5.4 | Verdict |
| --- | ---: | ---: | --- |
| Plugin `.is` predicate (valid) | 91.4 ns/op | 91.9 ns/op | Flat |
| `zod-compiler` `.is` (valid) | 92.0 ns/op | 90.5 ns/op | ~1.6% faster |
| Zod runtime `safeParse` (valid) | 652.5 ns/op | 627.1 ns/op | **~3.9% faster** |
| Zod runtime `safeParse` (75% valid mixed) | 2359.6 ns/op | 1201.7 ns/op | **~49% faster** |
| Backend org schema `safeParse` (valid) | 20045 ns/op | 20846 ns/op | ~4% slower |
| 80k runtime parse heap Δ | 0.339 MB | 0.331 MB | ~2% lower |
| 80k runtime parse RSS Δ | ~20.2 MB | ~17.0 MB | ~16% lower |
| 100× `z.string()` heap Δ | 0.042 MB | 0.045 MB | Noisy / flat |

## Method

- CPU: 5 runs × 80k iterations, `process.cpuUsage()` (see `scripts/bench_zod_stable_cpu.ts`)
- Memory: 5 runs, heap/RSS delta with `Bun.gc()` between samples (no `z.compile`)
- Fixtures: plugin update-request body shape (mock data, same as `bench_plugin_validation_cpu.ts`) and backend org row shape from `organization/get.ts`
- `bun test:unit` — 2548 tests passed on 4.5.4

## Recommendation

Upgrade is justified for backend Zod runtime `safeParse` validation (~40 Supabase
function files, including Deno edge functions on the same `zod` import): measurable
CPU win on valid and especially mixed valid/invalid paths on the representative
`updateRequestSchemaZod` fixture, plus lower RSS during parse bursts.

Plugin `/updates` production path uses extracted `.is` predicates (flat in this
bench). `/stats` and `/channel_self` were not separately benchmarked here — keep
`zod-compiler` + extracted `.is` predicates on those hot paths.

Re-run:

```bash
bun scripts/bench_plugin_validation_cpu.ts
BENCH_RUNS=5 bun scripts/bench_zod_stable_cpu.ts
```
