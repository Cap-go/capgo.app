# Marketing screenshots

Regenerates the console screenshots shown on capgo.app ([Cap-go/website](https://github.com/Cap-go/website), `apps/web/public/landing-demos/`).

```bash
bun run supabase:start
bun run serve:worktree        # keep running; note the port if it is not 5173
WEBSITE_DIR=../website BASE_URL=http://localhost:5173 bun run screenshots:marketing
```

- `bun run screenshots:marketing -- console-` captures only shots whose name starts with `console-`.
- `--no-seed` skips `seed.sql` when the demo data is already in place.
- Without `WEBSITE_DIR`, webp files land in `.context/marketing-screenshots/webp/`.

## What it does

1. `seed.sql` rewrites the `com.demo.app` seed app into a coherent demo: versions 4.7.2 to 4.8.2-beta.1 with native packages, a 25% rollout with auto-pause on production, and 30 days of native builds. It only runs against a local database.
2. `mocks.ts` serves the analytics-backed endpoints (stats, notifications, devices, API keys, webhooks) and the team/audit RPCs from `fixtures.ts`, and patches the org to look hardened (2FA, password policy) without locking the seed login.
3. `capture.ts` logs in as the seed user, captures every entry in `shots.ts` in dark mode at 2x, swaps seed emails for neutral demo identities, and encodes the configured webp crops.

All data is fake. Teammates use `@example.com` addresses. Never point this at a real account.

When a page layout changes, adjust its `prepare` step or crop in `shots.ts`, rerun, and check the raw captures in `.context/marketing-screenshots/png/` before opening the website PR.
