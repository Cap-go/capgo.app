# Organization sidebar entry

Screenshots from the real local console with seeded demo data, at 1280 × 720.
The baseline is `b285780b45`. No customer data or production services were used.

- `desktop-before.png` / `desktop-after.png`: expanded sidebar on Organization.
- `rail-before.png` / `rail-after.png`: collapsed sidebar on Apps.

Captured with `bun run visual:capture:before --routes org-settings,apps-sidebar-collapsed`
and the corresponding `visual:capture:after` command. The report is generated with
`bun run visual:diff --routes org-settings,apps-sidebar-collapsed`.

The sidebar browser suite also checks mobile navigation at 375 × 667, the
Organization destination, its active state, and its collapsed tooltip.
