---
name: modify-admin-dashboard
description: Route Capgo admin dashboard changes to its private repository. Use when a request modifies, fixes, reviews, or deploys the internal admin dashboard or its admin-only API.
---

# Modify Admin Dashboard

The dashboard deployed at `admin.capgo.app` is maintained in the private
[`Cap-go/capgo_admin_dashboard`](https://github.com/Cap-go/capgo_admin_dashboard)
repository. Treat that repository as the source of truth.

## Repository boundary

- Do not modify admin dashboard pages, components, stores, services, admin-only
  API handlers, authentication adapters, tests, or deployment configuration in
  `Cap-go/capgo`.
- Older dashboard code may remain in `Cap-go/capgo` during the transition. Do not
  update it, even when it looks like the relevant implementation.
- Shared database schema, cron processing, and aggregation producers may remain in
  `Cap-go/capgo` when they support more than the dashboard. Keep those changes
  separate from dashboard implementation changes.
- If a task needs both shared Capgo infrastructure and dashboard work, create one
  focused pull request in each repository.

## Workflow

1. Use an existing checkout of `Cap-go/capgo_admin_dashboard`, or clone
   `git@github.com:Cap-go/capgo_admin_dashboard.git` when no usable checkout is
   available.
2. Read that repository's `AGENTS.md` and work from its current `main` branch.
3. Preserve the dashboard's Cloudflare Access enforcement and read-only admin
   guardrails.
4. Run the validation commands documented in the private repository.
5. Commit, push, and open the pull request against
   `Cap-go/capgo_admin_dashboard:main`. Do not open a dashboard-only pull request
   in `Cap-go/capgo`.
