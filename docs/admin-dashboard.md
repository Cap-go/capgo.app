# Admin dashboard development

The Capgo admin dashboard has moved to the private
[`Cap-go/capgo_admin_dashboard`](https://github.com/Cap-go/capgo_admin_dashboard)
repository. That repository is the source of truth for the dashboard deployed at
`admin.capgo.app`.

Do not implement or update admin dashboard pages, components, stores, services,
admin-only API handlers, authentication adapters, or deployment configuration in
this repository. The web app only exposes an external link to `admin.capgo.app`
for platform admins, and legacy `/admin/*` routes redirect there. Open admin
dashboard pull requests against `Cap-go/capgo_admin_dashboard` instead.

Shared backend producers can still belong in this repository. This includes cron
processing, database schema, and aggregation jobs that also support Capgo outside
the admin dashboard. If a change spans shared infrastructure and the dashboard,
use separate pull requests: one in this repository for the shared change and one
in `Cap-go/capgo_admin_dashboard` for the dashboard change.

Agents working on dashboard requests should use the repository skill at
`.agents/skills/modify-admin-dashboard/SKILL.md`.
