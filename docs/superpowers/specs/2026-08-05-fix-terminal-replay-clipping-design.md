# Fix terminal replay clipping

## Problem

The replay SVG allocates 20 pixels per terminal row, but renders rows with a
20.3-pixel line height inside a `<pre>` that retains browser-default vertical
margins. A 100-column by 30-row frame therefore needs 669 pixels inside a
632-pixel viewport, clipping the final row.

## Design

Keep the existing row- and column-derived viewport. Make the SVG content match
that calculation by rendering at an exact 20-pixel line height and resetting
the generated `<pre>` to `margin: 0` with inherited font settings.

Add a deterministic 30-row regression assertion to the existing CLI replay
test. The assertion checks the production SVG markup contains both layout
normalizations and preserves the final-row sentinel. Capture throttling and all
other replay behavior remain unchanged.

## Verification

Run the focused replay test, CLI lint/typecheck/build/test checks, and a
headless-browser geometry smoke test showing no vertical overflow.
