# Cloudflare Workers Testing Guide

This guide explains how to run tests against Cloudflare Workers instead of
Supabase Edge Functions.

## Overview

By default, tests run against Supabase Edge Functions
(`supabase functions serve`). However, since production primarily uses
Cloudflare Workers, you can now run tests directly against local Cloudflare
Workers to ensure compatibility.

## Architecture

The application has three Cloudflare Workers:

1. **API Worker** (port 8787): Handles most API endpoints
   - `/bundle`, `/app`, `/device`, `/channel`, `/apikey`, `/organization`,
     `/statistics`
   - Private endpoints: `/private/*`
   - Trigger endpoints for cron jobs and database triggers

2. **Plugin Worker** (port 8788): Handles plugin-specific endpoints
   - `/updates`, `/channel_self`, `/stats`, `/ok`, `/latency`

3. **Files Worker** (port 8789): Handles file operations
   - File upload and download

## Prerequisites

1. Supabase must be running: `supabase start`
2. Database must be seeded: `supabase db reset`
3. Environment variables must be configured in `cloudflare_workers/.env.local`
   Note: `./scripts/start-cloudflare-workers.sh` overrides the Supabase keys at runtime using `supabase status` to match your local instance, and also sets Cloudflare-local defaults like `CLOUDFLARE_FUNCTION_URL`.
## Testing Modes

The workers support two testing modes:

### PostgreSQL

- Tests the traditional PostgreSQL code path
- Simpler and faster for basic testing

## Running Tests

### Option 1: Manual Setup (Recommended for Development)

1. Start the Cloudflare Workers:

   ```bash
   ./scripts/start-cloudflare-workers.sh
   ```

   This will start all three workers in the background. Press Ctrl+C to stop
   them.

   `wrangler dev` refuses a `compatibility_date` that is still in the future, so this script runs Wrangler with `--compatibility-date` set to today in UTC (override with `WRANGLER_DEV_COMPATIBILITY_DATE`). Deployed Workers still use the date in each `wrangler.jsonc`.

2. In another terminal, run the tests:
   ```bash
   bun test:cloudflare:all
   ```

### Option 2: Individual Test Suites

You can run specific test suites:

```bash
# Run all Cloudflare tests (excluding CLI tests)
bun test:cloudflare:backend

# Run only update-related tests
bun test:cloudflare:updates
```

### Option 3: Quick Test (Single Command)

For a quick test run without keeping workers alive:

```bash
# Start workers in background, run tests, then stop workers
./scripts/start-cloudflare-workers.sh &
WORKERS_PID=$!
sleep 5
bun test:cloudflare:all
kill $WORKERS_PID
```

## Environment Variables

The Cloudflare Worker tests use the following environment variables (set
automatically by `vitest.config.cloudflare.ts`):

- `USE_CLOUDFLARE_WORKERS=true` - Enables Cloudflare Worker mode
- `CLOUDFLARE_API_URL=http://127.0.0.1:8787` - API Worker URL
- `CLOUDFLARE_PLUGIN_URL=http://127.0.0.1:8788` - Plugin Worker URL
- `CLOUDFLARE_FILES_URL=http://127.0.0.1:8789` - Files Worker URL

## How It Works

The test utilities (`tests/test-utils.ts`) automatically route requests to the
correct worker:

- Plugin endpoints (`/updates`, `/channel_self`, `/stats`) → Plugin Worker
  (8788)
- All other endpoints → API Worker (8787)

This is done via the `getEndpointUrl()` helper function which determines the
correct worker based on the endpoint path.

## Differences from Supabase Edge Functions

1. **Port Configuration**: Cloudflare Workers run on different ports (8787,
   8788, 8789)
2. **Environment Loading**: Uses `cloudflare_workers/.env.local` instead of
   Supabase secrets
3. **Runtime**: Uses Cloudflare Workers runtime instead of Deno
4. **Worker Separation**: API and Plugin endpoints are handled by separate
   workers

## Troubleshooting

### Workers won't start

```bash
# Check if ports are already in use
lsof -i :8787
lsof -i :8788
lsof -i :8789

# Kill any existing wrangler processes
pkill -f "wrangler dev"
```

### Tests timeout

- Ensure Supabase is running: `supabase status`
- Check workers are responding:
  ```bash
  curl http://127.0.0.1:8787/ok
  curl http://127.0.0.1:8788/ok
  ```

### Database connection issues

- Verify `internal/cloudflare/.env.local` has correct database credentials
- Reset database: `supabase db reset`

## CI/CD Integration

To run Cloudflare Worker tests in CI:

```yaml
- name: Start Supabase
  run: supabase start

- name: Start Cloudflare Workers
  run: ./scripts/start-cloudflare-workers.sh &

- name: Wait for workers
  run: sleep 5

- name: Run tests
  run: bun test:cloudflare:all

- name: Stop workers
  run: pkill -f "wrangler dev"
```

## Development Tips

1. **Keep workers running**: Start workers once and run tests multiple times for
   faster iteration
2. **Watch mode**: Wrangler supports hot reload, changes to backend code will
   automatically restart workers
3. **Debug mode**: Add `--log-level debug` to wrangler commands in the start
   script for verbose logging
4. **Separate terminal**: Run workers in a dedicated terminal to see logs in
   real-time
