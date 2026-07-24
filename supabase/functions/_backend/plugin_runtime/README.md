# Plugin runtime (isolated)

This tree is the **only** backend code the Cloudflare plugin worker may import
from `_backend`, and the request-path code for Deno `updates` / `stats` /
`channel_self` / `updates_debug`.

Do **not** import from sibling `_backend` folders (`../utils`, `../private`,
`../public`, etc.). API / triggers / files workers must not import from this
tree.

Duplicates of formerly shared helpers are intentional so plugin perf work
cannot pull API-only dependencies back into the isolate.

Enforce with:

```bash
bun run check:plugin-runtime
```

Deno-only supabase-js stats fallbacks are registered from
`supabase/functions/shared/plugin_deno_stats_fallbacks.ts` (never from the CF
plugin entry).

When editing plugin hot paths, change files under this tree only. Do not
"temporarily" import helpers from `_backend/utils` — copy or reimplement inside
`plugin_runtime` instead.

<!-- ci: 2026-07-23T15:17:47Z -->
