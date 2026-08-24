# Capgo AI Coding Agent Instructions

## Pull Request Lifecycle (MANDATORY)

Follow **`AGENTS.md` → “Pull Request Lifecycle (MANDATORY for every agent)”** exactly:

1. Keep the PR a **draft** while coding.
2. When implementation is done and **all CI is green**, mark the PR **Ready for review** (that starts automatic AI review — not human review).
3. Wait for AI review; fix **every** comment until zero threads remain and AI is clear.
4. **Only then** ping a human.

Never ping a human while the PR is draft, CI is red/pending, AI review is unfinished, or any review thread is still open.

## Project Overview

Capgo is a live update platform for Capacitor apps, consisting of:
- **Frontend**: Vue 3 SPA built with Vite, Tailwind CSS, and DaisyUI
- **Backend**: Multi-platform edge functions (Cloudflare Workers primary, Supabase backup)
- **Database**: PostgreSQL via Supabase, with Cloudflare read path
- **Mobile**: Capacitor iOS/Android apps with OTA update capabilities

## Critical Architecture Patterns

### Multi-Platform Backend Deployment

The backend runs on **three platforms** with identical code:
1. **Cloudflare Workers** (99% of production traffic, ports 8787/8788/8789 locally)
2. **Supabase Edge Functions** (internal tasks, CRON jobs, local development)

Code lives in `supabase/functions/_backend/` and is deployed to all three platforms. Workers are split:
- **API Worker** (8787): `/bundle`, `/app`, `/device`, `/channel`, `/private/*`, `/triggers`
- **Plugin Worker** (8788): `/updates`, `/channel_self`, `/stats` 
- **Files Worker** (8789): File upload/download operations

Use `cloudflare_workers/{api,plugin,files}/index.ts` to see routing. All routes use Hono framework (`createHono` from `utils/hono.ts`).

### Database Layer: Postgres

Primary data stays in Postgres via Supabase, with read paths using region replicas and Cloudflare bindings.
- **functions**: `pg.ts` - `getPgClient()`, `getDrizzleClient()` using `postgres` package
- Schema defined in `utils/postgress_schema.ts` with Drizzle ORM

**Never edit committed migrations** in `supabase/migrations/`. Create new migrations with `supabase migration new <feature_slug>`.

### Request Context Flow

All endpoints receive Hono `Context` object:
```typescript
import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'

function myEndpoint(c: Context<MiddlewareKeyVariables>) {
  const requestId = c.get('requestId')  // For logging
  const apikey = c.get('apikey')        // Authenticated API key
  const auth = c.get('auth')            // Auth info (userId, authType)
}
```

Use `cloudlog({ requestId: c.get('requestId'), message: '...' })` for structured logging.

### Authentication Middleware

- API endpoints use `middlewareAPISecret` (internal) or `middlewareKey` (external API keys)
- Keys stored in `apikeys` table, validated against `owner_org` for authorization
- JWT auth available via `middlewareAuth` for user sessions
- Check `c.get('auth')?.authType` to determine 'apikey' vs 'jwt'

## Development Workflows

### Local Development Setup

```bash
# Start Supabase (required for all development)
bun run supabase:start

# Seed database with fresh test data
bun run supabase:db:reset

# Start frontend (localhost:5173)
bun serve:local  # Uses local env
bun serve:dev    # Uses development branch env

# Start backend edge functions
bun backend  # Supabase functions on :54321

# Start Cloudflare Workers (optional, for testing CF deployment)
./scripts/start-cloudflare-workers.sh
```

Test accounts (after `bun run supabase:db:reset`):
- `test@capgo.app` / `testtest` (demo user with data)
- `admin@capgo.app` / `adminadmin` (admin user)

### Testing Strategy

**Backend tests** (`tests/` directory, Vitest):
```bash
bun test:all          # All tests against Supabase
bun test:backend      # Exclude CLI tests
bun test:cli          # Only CLI tests (requires LOCAL_CLI_PATH=true)

# Cloudflare Workers testing
bun test:cloudflare:all      # All tests against CF Workers
bun test:cloudflare:backend  # Backend tests on CF Workers
```

Tests use `tests/test-utils.ts` helpers:
- `getEndpointUrl(path)` routes to correct worker based on endpoint
- `USE_CLOUDFLARE_WORKERS=true` env var switches backend target
- Tests modify local database; always reset before test runs

**Frontend tests** (Playwright):
```bash
bun test:front  # E2E tests in playwright/e2e/
```

### Code Quality Commands

```bash
bun lint          # ESLint for frontend (src/**/*.{vue,ts,js})
bun lint:fix      # Auto-fix linting issues
bun lint:backend  # ESLint for backend (supabase/**/*.{ts,js})
bun typecheck     # Vue + TypeScript type checking
bun types         # Generate Supabase types (after migrations)
```

**Never commit without running `bun lint:fix`** before validation.

## Database Conventions

### Migrations Workflow

1. Create migration: `supabase migration new <feature_slug>`
2. Edit the **single migration file** until feature ships
3. Test locally: `bun run supabase:db:reset` (applies all migrations + seed)
4. Update `supabase/seed.sql` for new/changed test fixtures
5. Push to cloud: `supabase db push --linked` (prod only)

**Critical rules:**
- One migration per feature, edit until merged
- Never modify previously committed migrations
- Seed data should support current tests, not historical states
- Run `bun types` after schema changes to regenerate TypeScript types

### Drizzle ORM Patterns

Schema in `postgress_schema.ts` mirrors SQL tables:
```typescript
import { schema } from './postgress_schema.ts'
const data = await drizzleClient
  .select({ id: schema.apps.id, name: schema.apps.name })
  .from(schema.apps)
  .where(eq(schema.apps.owner_org, orgId))
  .limit(1)
```

Use `aliasV2()` for self-joins or multiple table references in same query.

## Frontend Conventions

### Vue 3 Composition API

Use `<script setup>` syntax exclusively:
```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'

const count = ref(0)
const route = useRoute()
</script>
```

### Styling Standards

- **Tailwind utility classes** for layout/spacing
- **DaisyUI components** (`d-btn`, `d-input`, `d-card`) for interactive elements
- **Konsta components** ONLY for safe area helpers (top/bottom insets)
- Color palette from `src/styles/style.css`: `--color-azure-500: #119eff` (primary), `--color-primary-500: #515271` (text/backgrounds)

Avoid custom CSS; prefer utility composition and DaisyUI theming.

### File-Based Routing

Routes auto-generated from `src/pages/` via `unplugin-vue-router`:
- `src/pages/app/[id].vue` → `/app/:id`
- Use `useRoute()` for params, `useRouter()` for navigation
- TypeScript types in `src/typed-router.d.ts` (auto-generated)

## Deployment & CI/CD

**Do not manually deploy or commit version bumps.** CI/CD handles:
- Version bumping in `package.json`
- `CHANGELOG.md` generation (semantic-release)
- Deployment to Cloudflare/Supabase after merge to `main`

If deployment is needed (exceptional cases):
```bash
# Cloudflare Workers
bun deploy:cloudflare:api:prod
bun deploy:cloudflare:plugins:prod

# Supabase Functions  
bun deploy:supabase:prod
```

## Key Files Reference

| Path | Purpose |
|------|---------|
| `supabase/functions/_backend/` | Shared backend code for all platforms |
| `cloudflare_workers/{api,plugin,files}/index.ts` | Platform-specific entry points |
| `supabase/functions/_backend/utils/hono.ts` | Hono app factory, middleware, error handling |
| `supabase/functions/_backend/utils/pg.ts` | Postgres database layer |
| `tests/test-utils.ts` | Test helpers, endpoint routing, seeding |
| `scripts/utils.mjs` | Environment config, branch detection |
| `src/services/supabase.ts` | Frontend Supabase client setup |

## Common Pitfalls
1. **Mixing backend platforms**: Use shared code in `supabase/functions/_backend/`
2. **Editing old migrations**: Always create new migration files
3. **Forgetting lint before commit**: `bun lint:fix` is required
4. **Hard-coding URLs**: Use `getRightKey()` from `scripts/utils.mjs` for environment-specific config
5. **Missing requestId in logs**: Always use `cloudlog({ requestId: c.get('requestId'), ... })`
6. **Importing from wrong paths**: Backend uses `./utils/`, frontend uses `~/` alias for `src/`
7. **Testing without CF Workers**: Run `./scripts/start-cloudflare-workers.sh` for full coverage

## Environment Variables

Managed in `configs.json` (local) and `internal/cloudflare/.env.*` (deployed):
- `BRANCH=local|development|main` selects config environment
- Local: `bun serve:local` (localhost Supabase)
- Dev: `bun serve:dev` (development branch config)

Use `getRightKey(keyname)` to access environment-specific values.
