# Console to manage and distribute your live update

<p align='center'>
  <img src='https://capgo.app/readme-banner.svg?repo=Cap-go/capgo' alt='Capgo - Instant updates for capacitor'/>
</p>

[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=bugs)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=ncloc)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Technical Debt](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=sqale_index)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Duplicated Lines (%)](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=duplicated_lines_density)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=Cap-go_capgo&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=Cap-go_capgo)
[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://codspeed.io/Cap-go/capgo?utm_source=badge)
[![Known Vulnerabilities](https://snyk.io/test/github/Cap-go/capgo/badge.svg)](https://snyk.io/test/github/Cap-go/capgo)
![GitHub license](https://img.shields.io/github/license/Cap-go/capgo)
[![Bump version](https://github.com/Cap-go/capgo/actions/workflows/bump_version.yml/badge.svg)](https://github.com/Cap-go/capgo/actions/workflows/bump_version.yml)
[![Build source code and send to Capgo](https://github.com/Cap-go/capgo/actions/workflows/build_and_deploy.yml/badge.svg)](https://github.com/Cap-go/capgo/actions/workflows/build_and_deploy.yml)
<a href="#badge">
<img alt="semantic-release" src="https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg">
</a>
<a href="https://commitizen.github.io/cz-cli/"><img alt="Commitizen friendly" src="https://img.shields.io/badge/commitizen-friendly-brightgreen.svg"></a>

<br>

<div align="center">
  <h2><a href="https://capgo.app/?ref=plugin"> ➡️ Get Instant updates for your App with Capgo </a></h2>
  <h2><a href="https://capgo.app/consulting/?ref=plugin"> Missing a feature? We’ll build the plugin for you 💪</a></h2>
</div>
<br>

## Features

- ☁️ Cloud / Self hosted Support: Use our [Cloud](https://capgo.app/) to manage
  your app updates or yours.
- 📦 Bundle Management: Download, assign to channel, rollback.
- 📺 Channel Support: Use channels to manage different environments.
- 🎯 Set Channel to specific device to do QA or debug one user.
- 🔄 Auto Update: Automatically download and set the latest bundle for the app.
- ✅ Official Appflow alternative: our Capacitor updater plugin is the official alternative to Ionic Appflow.
- 🛟 Rollback: Reset the app to last working bundle if an incompatible bundle
  has been set.
- 🔁 **Delta Updates**: Make instant updates by only downloading changed files.
- 🔒 **Security**: Encrypt and sign each updates with best in class security
  standards.
- ⚔️ **Battle-Tested**: Used in more than 3000 projects.
- 📊 View your deployment statistics
- 🔋 Supports Android and iOS
- ⚡️ Capacitor 8/7/6/5 support
- 🌐 **Open Source**: Licensed under GNU AFFERO GENERAL PUBLIC LICENSE
- 🌐 **Open Source Backend**: Self install
  [our backend](https://github.com/Cap-go/capgo) in your infra

<br>

## Usage

Capgo is deployed to production on Cloudflare workers and Supabase.

Cloudflare workers take 99% of the traffic. Supabase is used for internal calls,
for internal tasks such as CRON jobs that call functions.

When self-hosted, installing only Supabase is sufficient.

## Why Cloudflare Workers + Supabase

We support both deployments for practical reasons:

- **Supabase** is the legacy backend and the only required piece for
  self-hosting.
- **Cloudflare Workers** runs the same backend code (via the Hono adapter) but is
  much cheaper at Capgo scale. With ~50M devices, Supabase Edge Functions are
  cost-prohibitive because they follow AWS pricing. Cloudflare is ~10x cheaper
  for our traffic profile.

In production, we route most traffic through Cloudflare Workers for cost and
scale, while Supabase remains the reference backend and the default for
self-hosted deployments. Private endpoints and trigger/CRON workloads still run
on Supabase in production.

## Project structure (self-hosting map)

If you're self-hosting, the key pieces live in a few top-level directories:

- `supabase/` - **Primary backend for self-hosting**
  - `supabase/functions/` - Edge functions (Deno) that power the API
    - `_backend/` - Core implementation used by both Supabase and Cloudflare
    - `public/` - Public API routes used by customers and apps
    - `private/` - Internal API routes for the console and ops tooling
    - `plugins/` - Plugin endpoints (updates, stats, channel_self, etc.)
    - `triggers/` - Database triggers and CRON functions
  - `supabase/migrations/` - Database schema and RLS policies
  - `supabase/seed.sql` - Local seed data for tests/dev
- `supabase/schemas/prod.sql` - Production schema dump (reference only)
- `cloudflare_workers/` - **Optional** Cloudflare Workers deployment (prod traffic)
  - `cloudflare_workers/snippet/` - Geo routing for replicas
  - Worker entry points and deploy config live here
- `src/` - Frontend Vue 3 web console (Vite + Tailwind + DaisyUI)
  - `src/pages/` - File-based routes
  - `src/components/` - Reusable UI components
  - `src/services/` - API clients and integrations
  - `src/stores/` - Pinia stores
- `sql/` - Raw SQL helpers and maintenance scripts
- `scripts/` - Dev/build scripts used by CI and local tooling
- `tests/` - Backend Vitest tests (run in parallel)
- `playwright/` - Frontend E2E tests
- `docs/` - Extra documentation and guides
- `android/`, `ios/` - Capacitor native projects (mobile builds)

Quick self-hosting path:

1. `supabase/` is enough to run the backend locally.
2. `src/` is the web console you point to your own backend.
3. `cloudflare_workers/` is only needed if you want to run the Workers layer
   instead of (or in front of) Supabase.

## Backend endpoints (what lives where)

The backend is split by responsibility to keep routes clear and access scoped:

- `supabase/functions/_backend/public/` - **Public API** exposed to customers.
  This is the documented API on the website for customers that want to interact
  with Capgo programmatically (apps, channels, bundles, devices, etc.).
- `supabase/functions/_backend/private/` - **Private API** used internally.
  The console (web UI) uses this heavily for admin/ops workflows. It is not
  publicly accessible. Some UI flows still use the public API where appropriate.
- `supabase/functions/_backend/plugin_runtime/` - **Plugin API** used by the
  `@capgo/capacitor-updater` plugin running inside apps:
  - `plugins/updates` - device update checks and bundle download flow
  - `plugins/stats` - upload usage stats from devices
  - `plugins/channel_self` - allow a device to opt into a channel (QA/debug)
- `supabase/functions/_backend/triggers/` - **Triggers & CRON** for automated
  backend jobs (queue consumers, scheduled tasks, DB-triggered flows).

When self-hosting, you generally expose `public` + `plugin_runtime` (via the
plugin worker / Deno `updates` · `stats` · `channel_self` entries). `private`
should stay internal and locked down. `triggers` runs automatically.

## Production schema (prod.sql)

`supabase/schemas/prod.sql` is a schema dump of the production database. It is
generated via `bun run schemas` (or `bun run schemas:local`) and is meant for
reference/diffing, not as a source of truth. All actual schema changes live in
`supabase/migrations/`.

## Documentation

https://github.com/Cap-go/capacitor-updater/wiki/Capgo-Sandbox-App

- [Changing Supabase](supabase/migration_guide.md)

## Plugins

All the following official plugins are already installed and pre-configured:

- [Action Sheet](https://github.com/ionic-team/capacitor-plugins/tree/main/action-sheet) -
  Provides access to native Action Sheets.
- [App](https://github.com/ionic-team/capacitor-plugins/tree/main/app) - Handles
  high level App state and events.
- [App Launcher](https://github.com/ionic-team/capacitor-plugins/tree/main/app-launcher) -
  Allows to check if an app can be opened and open it.
- [Browser](https://github.com/ionic-team/capacitor-plugins/tree/main/browser) -
  Provides the ability to open an in-app browser and subscribe to browser
  events.
- [Camera](https://github.com/ionic-team/capacitor-plugins/tree/main/camera) -
  Provides the ability to take a photo with the camera or choose an existing one
  from the photo album.
- [Clipboard](https://github.com/ionic-team/capacitor-plugins/tree/main/clipboard) -
  Enables copy and pasting to/from the system clipboard.
- [Device](https://github.com/ionic-team/capacitor-plugins/tree/main/device) -
  Exposes internal information about the device, such as the model and operating
  system version, along with user information such as unique ids.
- [Dialog](https://github.com/ionic-team/capacitor-plugins/tree/main/dialog) -
  Provides methods for triggering native dialog windows for alerts,
  confirmations, and input prompts.
- [Filesystem](https://github.com/ionic-team/capacitor-plugins/tree/main/filesystem) -
  Provides a NodeJS-like API for working with files on the device.
- [Geolocation](https://github.com/ionic-team/capacitor-plugins/tree/main/geolocation) -
  Provides simple methods for getting and tracking the current position of the
  device using GPS, along with altitude, heading, and speed information if
  available.
- [Haptics](https://github.com/ionic-team/capacitor-plugins/tree/main/haptics) -
  Provides physical feedback to the user through touch or vibration.
- [Keyboard](https://github.com/ionic-team/capacitor-plugins/tree/main/keyboard) -
  Provides keyboard display and visibility control, along with event tracking
  when the keyboard shows and hides.
- [Local Notifications](https://github.com/ionic-team/capacitor-plugins/tree/main/local-notifications) -
  Provides a way to schedule device notifications locally (i.e. without a server
  sending push notifications).
- [Motion](https://github.com/ionic-team/capacitor-plugins/tree/main/motion) -
  Tracks accelerometer and device orientation (compass heading, etc.).
- [Network](https://github.com/ionic-team/capacitor-plugins/tree/main/network) -
  Provides network and connectivity information.
- [Push Notifications](https://github.com/ionic-team/capacitor-plugins/tree/main/push-notifications) -
  Provides access to native push notifications.
- [Screen Reader](https://github.com/ionic-team/capacitor-plugins/tree/main/screen-reader) -
  Provides access to TalkBack/VoiceOver/etc. and Provides simple text-to-speech
  capabilities for visual accessibility.
- [Share](https://github.com/ionic-team/capacitor-plugins/tree/main/share) -
  Provides methods for sharing content in any sharing-enabled apps the user may
  have installed.
- [Splash Screen](https://github.com/ionic-team/capacitor-plugins/tree/main/splash-screen) -
  Provides methods for showing or hiding a Splash image.
- [Status Bar](https://github.com/ionic-team/capacitor-plugins/tree/main/status-bar) -
  Provides methods for configuring the style of the Status Bar, along with
  showing or hiding it.
- [Storage](https://github.com/ionic-team/capacitor-plugins/tree/main/storage) -
  Provides a simple key/value persistent store for lightweight data.
- [Text Zoom](https://github.com/ionic-team/capacitor-plugins/tree/main/text-zoom) -
  Provides the ability to change Web View text size for visual accessibility.
- [Toast](https://github.com/ionic-team/capacitor-plugins/tree/main/toast) -
  Provides a notification pop up for displaying important information to a user.
  Just like real toast!

## Tests

Tests are split by backend (API/plugin), CLI, database SQL, and frontend:

- `tests/` - Backend Vitest tests (API + plugin + CLI)
- `playwright/e2e/` - Frontend Playwright tests
- `supabase/tests/` - SQL tests for functions, RLS, and DB logic

Backend test groups (Vitest):

- API tests: public/private endpoints and general backend behavior
- Plugin tests: `tests/updates*.test.ts`, `tests/stats*.test.ts`,
  `tests/channel_self*.test.ts`
- CLI tests: `tests/cli*.test.ts` (CLI auth, upload, metadata, etc.)

Run tests:

```bash
# Supabase Edge Functions (default)
bun test:all
bun test:backend
bun test:cli
bun test:front

# CLI workspace
bun run cli:build
bun run cli:test
bun run cli:check

# Legacy aliases kept for compatibility
bun test:local
bun test:all:local
bun test:cli:local

# Database SQL tests (Supabase CLI)
supabase test db

# Cloudflare Workers
bun test:cloudflare:all
bun test:cloudflare:backend
bun test:cloudflare:updates

# Local Cloudflare Workers (required for cloudflare tests)
./scripts/start-cloudflare-workers.sh
```

Notes:

- Tests run in parallel across files. If a test mutates shared data, add
  dedicated seed data in `supabase/seed.sql`.
- The repository is a Bun workspace monorepo. The Capgo app lives at the root
  and the CLI lives in `cli/`.
- Capgo's Vitest CLI coverage now resolves the local `cli/` workspace by
  default, so monorepo changes are exercised together.
- SQL tests in `supabase/tests/` are run by the Supabase CLI test runner.
- Run `bun run supabase:start` first so the local DB is available (worktree-isolated).

## Dev contribution

### Coding Style

- Use Composition API with
  [`<script setup>` SFC syntax](https://github.com/vuejs/rfcs/pull/227)
- [ESLint](https://eslint.org/) with
  [@antfu/eslint-config](https://github.com/antfu/eslint-config), single quotes,
  no semi.

### Dev tools

- [TypeScript](https://www.typescriptlang.org/)
- [bun](https://bun.sh/) - fast javascript runtime, package manager, bundler,
  test runner an all-in-one toolkit
- [critters](https://github.com/GoogleChromeLabs/critters) - Critical CSS
- [Cloudflare](https://www.cloudflare.com/) - zero-config deployment
- [VS Code Extensions](./.vscode/extensions.json)
  - [Vite](https://marketplace.visualstudio.com/items?itemName=antfu.vite) -
    Fire up Vite server automatically
  - [Volar](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.volar) -
    Vue 3 `<script setup>` IDE support
  - [Iconify IntelliSense](https://marketplace.visualstudio.com/items?itemName=antfu.iconify) -
    Icon inline display and autocomplete
  - [i18n Ally](https://marketplace.visualstudio.com/items?itemName=lokalise.i18n-ally) -
    All in one i18n support
  - [Windi CSS Intellisense](https://marketplace.visualstudio.com/items?itemName=voorjaar.windicss-intellisense) -
    IDE support for Windi CSS
  - [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)


### Deploy on Cloudflare Pages

Use the CLI to deploy to preprod

```bash
bun run dev-build
# then deploy
bun run deploy:cloudflare:console:preprod
```

or Prod

```bash
bun run build
# then deploy
bun run deploy:cloudflare:console:prod
```

### Development

You will need to start each local server in separate terminals.

Before continuing, ensure you have the following installed:

- [Docker](https://www.docker.com/)
- [bun](https://bun.sh/)
- [Supabase CLI](https://supabase.com/docs/guides/cli)

You can install the `supabase` CLI globally with `bun install supabase -g` and
you'll be able to invoke `supabase` from anywhere.

Alternatively, you can install the `supabase` CLI locally with
`bun install supabase --save-dev` but, to invoke it, you have to use:
`./node_modules/supabase/bin/supabase`.

In the following guideline, we will assume that you have installed the
`supabase` CLI globally.

#### Start Supabase DB Locally

Start the Supabase DB:

```bash
bun run supabase:start
```

Ports may differ per git worktree. To see the exact URLs/keys for the current worktree run:

```bash
bun run supabase:status
```

#### Seed Supabase DB locally

[!WARNING] ⚠️ Ensure Docker is running.

```bash
bun run supabase:db:reset
```

#### Start Frontend locally

```bash
bun install
bun serve:local
```

#### Login

Visit http://localhost:5173

There are two login credentials you can use:

| Account    | Username        | Password   |
| ---------- | --------------- | ---------- |
| Demo User  | test@capgo.app  | testtest   |
| Admin User | admin@capgo.app | adminadmin |

The _demo user_ account has some demo data in it. If the data is not fresh, just
reset the db with `supabase db reset`. The seed has been made in a way that
ensures the data is always fresh.

The _admin user_ account has administration rights so the user can impersonate
other users. You can find the interface for that in the "Account" section.

#### Supabase DB Reset

[!WARNING] ⚠️ Ensure Docker is running.

This will seed the DB with demo data.

```bash
supabase db reset
```

### Deploy Supabase self hosted

To deploy the supabase instance in self-hosted, use the
[Supabase official guide](https://supabase.com/docs/guides/self-hosting).

Before deploying, duplicate `supabase/functions/.env.example` to
`supabase/functions/.env`, replace the placeholder values with your
self-hosted credentials, and keep the file local (it is gitignored). Use that
file for commands such as
`supabase secrets set --env-file supabase/functions/.env`.

Organization invitation emails depend on Bento. If `BENTO_PUBLISHABLE_KEY`,
`BENTO_SECRET_KEY`, and `BENTO_SITE_UUID` are not configured in
`supabase/functions/.env` and synced to Supabase secrets, invite-org emails
will not be sent.

### Deploy Supabase cloud

To deploy the Supabase instance on cloud, you need a paid account, which costs
$25/month.

Link the project to the cloud with the following command:

```bash
supabase link
```

https://supabase.com/docs/reference/cli/supabase-link

Then you need to push the migrations to the cloud with the following command:

```bash
supabase db push --linked
```

https://supabase.com/docs/reference/cli/supabase-migration-up

And seed the DB with demo data:

```bash
supabase seed buckets
```

https://supabase.com/docs/reference/cli/supabase-seed-buckets

Seed the secret for functions:

```bash
supabase secrets set --env-file supabase/functions/.env
```

Push the functions to the cloud:

```bash
supabase functions deploy
```

### Environment Variables for Self-Hosted Deployments

By default, the configuration uses Capgo production values from [configs.json](configs.json). For self-hosted deployments, you **must override** all configuration values using environment variables.

#### Required Environment Variables

All configuration keys from `configs.json` can be overridden by setting their uppercase equivalent as environment variables:

| Environment Variable | Description | Default (Prod) | Required for Self-Hosted |
|---------------------|-------------|----------------|--------------------------|
| `BASE_DOMAIN` | Console domain | `console.capgo.app` | ✅ Yes |
| `SUPA_ANON` | Supabase anonymous key | Capgo production key | ✅ Yes |
| `SUPA_URL` | Supabase URL | `https://sb.capgo.app` | ✅ Yes |
| `API_DOMAIN` | API domain | `api.capgo.app` | ✅ Yes |
| `CAPTCHA_KEY` | Turnstile captcha key | Capgo production key | ⚠️ Optional |

#### Example Self-Hosted Configuration

```bash
# .env file for self-hosted deployment
BASE_DOMAIN=console.yourdomain.com
SUPA_ANON=your-supabase-anon-key
SUPA_URL=https://your-supabase-url.supabase.co
API_DOMAIN=api.yourdomain.com
CAPTCHA_KEY=your-turnstile-key
```

#### Bento Email Variables

If you want organization invitation emails to work, you also need to configure
these Bento environment variables:

```bash
BENTO_PUBLISHABLE_KEY=your-bento-publishable-key
BENTO_SECRET_KEY=your-bento-secret-key
BENTO_SITE_UUID=your-bento-site-uuid
```

#### How It Works

The configuration system (`scripts/utils.mjs`) checks for environment variables first:
1. If an uppercase environment variable exists (e.g., `SUPA_URL`), it uses that value
2. Otherwise, it falls back to the appropriate value from `configs.json` based on the branch (`prod`, `preprod`, `development`, or `local`)

**Important:** Without setting these environment variables, your self-hosted instance will attempt to connect to Capgo's production infrastructure, which will fail.

### Build

To build the web app in mobile, in order to push to mobile stores, run:

```bash
bun install
bun mobile
```

And you will see the generated files in the `dist` directory, ready to be served
on stores.
