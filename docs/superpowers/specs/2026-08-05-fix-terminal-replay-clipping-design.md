# Fix terminal replay clipping

## Problem

The replay SVG allocates 20 pixels per terminal row, but renders rows with a
20.3-pixel line height inside a `<pre>` that retains 14-pixel browser-default
top and bottom margins. A 30-row frame therefore needs 669 pixels: 609 pixels
of row content, 32 pixels of viewport padding, and 28 pixels of `<pre>` margins.
The available viewport is 632 pixels, so the final row is clipped.

## Design

Keep the existing row- and column-derived viewport. Make the SVG content match
that calculation by rendering at an exact 20-pixel line height and resetting
the generated `<pre>` to `margin: 0` with inherited font settings.

Add a deterministic 30-row regression assertion to the existing CLI replay
test. The assertion checks the production SVG markup contains both layout
normalizations and that 30 rows plus vertical padding exactly equal the SVG
viewport height. Capture throttling and all other replay behavior remain
unchanged.

## Verification

Run the focused replay test, CLI lint/typecheck/build/test checks, and a
headless-browser geometry smoke test showing no vertical overflow.
