# Date Range Picker Positioning Fix

## Problem

The shared date range picker measures its trigger and assigns a viewport-relative
`right` offset to a fixed, body-teleported `<dialog>`. Browsers also give native
dialogs an inline-start position. Because the picker sets a fixed width without
clearing that default, the dialog is over-constrained and the browser keeps it at
the viewport's left edge instead of honoring the calculated right alignment.

## Design

Reset the popover's inline-start position with `left: auto`. Keep the existing
`getBoundingClientRect()` measurement, body teleport, responsive width, and
scroll/resize position updates unchanged. This directly removes the conflicting
native-dialog default without adding another positioning dependency or changing
the component API.

## Testing

Add a focused regression test for the shared picker that verifies the popover
explicitly resets its left position while retaining the calculated right offset.
Run the focused test, frontend lint, and TypeScript checking before publishing.

## Scope

This change affects every existing `DateRangePicker` consumer, including devices,
logs, and admin views. It does not change date selection, presets, filtering, or
responsive calendar behavior.
