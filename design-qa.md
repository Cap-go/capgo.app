# A/B Tests Admin Dashboard Design QA

final result: passed

## Comparison target

- Source visual truth: `/Users/michaltremblay/.codex/generated_images/01a091e1-c116-7210-b9d0-37fc7d8f4cf0/exec-e06fa3ec-baf9-4cfe-b913-a08f3e45e4e8.png`
- Browser-rendered implementation: `output/playwright/admin-ab-tests-compact-matrix.png`
- Responsive implementation: `output/playwright/admin-ab-tests-compact-matrix-mobile.png`
- Route/state: the real `AdminABTestDistributionMatrix.vue` component mounted in a temporary guest-only local preview with realistic synthetic data; the temporary preview route was removed after capture.
- Theme: light.

## Normalization

- Source image: 1487 x 1058 pixels. It includes the Capgo sidebar and admin tab shell.
- Desktop implementation: 1536 x 1080 pixels at a 1536 x 1080 CSS viewport and `devicePixelRatio: 1`. The focused card measured 1280 x 724.57 CSS pixels.
- Mobile implementation: 390 x 844 pixels at a 390 x 844 CSS viewport and `devicePixelRatio: 1`.
- Comparison scope: the A/B test content region. The existing application supplies the sidebar and admin tabs outside the new page, so shell differences were excluded. The source's five example tests were illustrative; the implementation intentionally renders the four tests currently configured in `ab_tests.json`.

## Evidence

### Full view

The source and desktop implementation were opened together in one comparison input. The implementation preserves the selected compact-matrix composition: one bordered white card on the blue admin canvas, a concise heading and total, three desktop columns, restrained row dividers, large tabular counts, percentages beside the counts, and a blue/violet split distribution rail for every test.

### Focused regions

A separate crop was unnecessary because the 1536 x 1080 comparison keeps the header, column labels, branch names, counts, percentages, dividers, and rails readable at native density. The first row was checked directly for the requested example: New emails 400 (49.8%) and Old emails 403 (50.2%).

### Responsive state

At 390 x 844, the desktop column header hides and each experiment stacks into a readable card row. Both branch labels, counts, percentages, and the split rail remain visible without horizontal overflow. The page scrolls to expose every configured test.

### Primary interactions and console

- Verified responsive reflow at desktop and narrow-mobile breakpoints.
- Verified vertical scrolling reaches the final experiment.
- Verified progress bars expose accessible names and numeric values.
- The loaded feature emitted no console errors. The local app has pre-existing Vue Router deprecation warnings unrelated to this page.
- Loading, empty, invalid-response, error, and retry behavior are covered by the component/service wiring and unit tests; the primary browser-rendered state used the loaded distribution.

## Required fidelity surfaces

- Fonts and typography: Uses the application's existing font stack and slate hierarchy. Heading, row labels, tabular counts, percentages, wrapping, and optical weights match the source's compact admin treatment.
- Spacing and layout rhythm: Card radius, border, internal padding, three-column tracks, dividers, row height, and rail placement follow the source. The mobile stack preserves clear grouping and touch-safe spacing.
- Colors and visual tokens: Uses the existing blue admin canvas, white/slate surfaces, slate text and borders, Capgo blue for variant A, and violet for variant B. Contrast remains clear in light and dark token variants.
- Image quality and asset fidelity: This data view has no imagery. The feature uses the project's Heroicons beaker for the admin tab and no handcrafted or placeholder visual assets.
- Copy and content: The page states that it shows assignment distribution, identifies every configured experiment and branch with human-readable labels, and displays both counts and one-decimal percentages. Synthetic capture data contains no customer information.

## Findings

- No actionable P0, P1, or P2 differences remain.
- P3: The source mock has five illustrative experiments while the live configuration currently has four. Rendering configuration rather than mock-only rows is intentional and required.

## Comparison history

1. Desktop source and implementation were compared together after normalizing to the focused content region. No actionable P0/P1/P2 mismatch was found, so no visual correction iteration was required.
2. The mobile state was captured and scrolled through. No clipping, horizontal overflow, or unreadable branch content was found.

## Implementation checklist

- [x] Render every configured A/B test.
- [x] Show raw assignment counts and percentages.
- [x] Keep test and branch labels in the shared configuration.
- [x] Match the selected compact-matrix visual hierarchy.
- [x] Reflow cleanly on narrow screens.
- [x] Expose progress-bar values to assistive technology.
- [x] Verify the implementation in the Codex in-app browser.
