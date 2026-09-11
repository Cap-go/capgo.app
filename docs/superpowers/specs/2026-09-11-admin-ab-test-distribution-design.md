# Admin A/B Test Distribution Design

## Goal

Add a read-only **A/B Tests** page to the platform admin dashboard. The page gives administrators one place to see how every configured A/B test is distributed, using both assignment counts and percentages.

## Scope

The first version shows only assignment distribution. It does not show conversion, winners, statistical significance, time-series data, experiment status, editing, or experiment creation.

All tests come from the existing `ab_tests.json` configuration. Every configured test appears even when it has no assignments. Display labels for tests and branches live beside the assignment configuration so a newly configured test cannot silently disappear from the dashboard or require a second frontend-only registry.

## Data Flow

1. The existing authenticated `/private/admin_stats` endpoint accepts a new `ab_test_distribution` metric category.
2. A focused backend helper reads assignment counts from `public.users.onboarding.abtests` on the read replica. The query expands only the configured test names and groups by test and branch.
3. The helper merges grouped rows with the full A/B test configuration, returns zero-count configured tests, and calculates one-decimal percentages.
4. The existing admin dashboard store caches the response for five minutes.
5. The new page renders the result as the approved compact matrix.

The query is an admin-only, low-frequency aggregate. It performs one bounded result aggregation over the users table and returns at most two rows per configured test. It does not run on a plugin or other high-volume request path and does not expose customer-identifying data.

## Interface

The admin tab row gains an **A/B Tests** entry. The page uses the existing admin shell and light/dark tokens.

The content is one shared white surface with a subtle divider between experiments. Each experiment includes:

- experiment label and total assignments;
- two variant columns containing the variant label, count, and percentage;
- one thin, two-color distribution bar under the variant values.

Desktop uses a three-column matrix matching the selected concept. Narrow screens stack the experiment summary and variant rows while preserving the same information. Counts use locale-aware formatting and tabular numerals. Percentages are announced with visible text, so color is not the only way to read the split.

## States

- **Loading:** the existing page loader.
- **Loaded:** every configured test, including tests with zero assignments.
- **Empty:** a clear message if configuration contains no tests.
- **Error:** a compact error notice with a retry button.

## Verification

- Unit-test configuration display metadata, aggregation, ordering, zero counts, and percentage calculation.
- Unit-test the admin metric schema and page wiring.
- Run lint, typecheck, the focused unit tests, and the production build.
- Render the page at the selected 1440 × 1024 target and a narrow viewport, then complete design QA against option 3.
- Open a pull request and apply the `pr-ready` stable-green process.

