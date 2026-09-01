# Zod 4.4.3 → 4.5.4 benchmark comparison

Captured on the same VM with `bun scripts/bench_plugin_validation_cpu.ts` and
`bun scripts/bench_zod_memory.ts` before/after the upgrade.

## Summary

| Area | 4.4.3 | 4.5.4 | Verdict |
| --- | --- | --- | --- |
| Plugin hot path (production `.is` predicate) | ~96 ns/op valid | ~97 ns/op valid | Unchanged — still fastest |
| Raw `zod` runtime `safeParse` | ~1107 ns/op valid | ~1153 ns/op valid | Still too slow for plugin traffic |
| `zod-compiler` AOT `.is` | ~93 ns/op valid | ~89 ns/op valid | Still best compile option for Workers (no `eval`) |
| `z.compile()` `safeParse` | N/A | ~261 ns/op valid | ~4.4× faster than runtime Zod, but ~3× slower than AOT `.is` |
| 100× bare `z.string()` heap | +0.079 MB | +0.042 MB | **~47% less retained heap** |
| `z.compile()` one-time cost | N/A | +0.167 MB per compiled schema | JIT compiler footprint |

## CPU (80k iterations, update request body shape)

| Validator | 4.4.3 ns/op (valid) | 4.5.4 ns/op (valid) |
| --- | ---: | ---: |
| production `.is` predicate | 95.8 | 96.9 |
| zod-compiler `.is` | 92.7 | 89.1 |
| zod runtime `safeParse` | 1107.1 | 1153.2 |
| `z.compile()` `safeParse` | — | 261.1 |
| handrolled Standard Schema | 248.9 | 231.6 |

Mixed valid/invalid (75% valid): `z.compile()` mixed path is ~712 ns/op because invalid
inputs fall back to the full runtime parser (by design in Zod 4.5).

## Memory

| Measurement | 4.4.3 heap Δ | 4.5.4 heap Δ |
| --- | ---: | ---: |
| 100× `z.string()` | 0.079 MB | 0.042 MB |
| update request object schema | 0.001 MB | 0.001 MB |
| `z.compile(updateSchema)` | — | 0.167 MB |
| 80k compiled `safeParse` (steady-state) | — | 0.054 MB |

## Recommendation

1. **Upgrade to Zod 4.5.4** — lower baseline memory for every backend schema; no behavior change.
2. **Keep plugin `/updates` `/stats` `/channel_self` on extracted `.is` predicates** — still beats `z.compile()` and avoids Cloudflare Workers CSP (`new Function` / `eval`).
3. **Keep `zod-compiler` for build-time AOT** where we need Worker-safe fast paths without importing `zod`.
4. **`compileZodSchema()` helper** (added in `schema_validation.ts`) is available for Supabase-only or Node paths that parse frequently with full Zod error messages — not wired into plugin worker yet.

Re-run locally:

```bash
bun scripts/bench_plugin_validation_cpu.ts --save scripts/bench/plugin_validation_cpu_results.json
bun scripts/bench_zod_memory.ts --save scripts/bench/zod_memory_results.json
```
