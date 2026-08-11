# Hide the pre-organization terminal option

## Problem

The unified `/onboarding/app` flow renders the shared “Use the terminal
instead” control before an organization or app exists. Expanding it cannot
produce a usable CLI command because API-key creation requires an organization.
The component also skips API-key provisioning in `preOrg` mode, so the expanded
panel displays “Creating your secure API key…” indefinitely even though no
request is running.

## Design

Do not render the collapsed terminal option or its command panel while
`AppOnboardingFlow` is in `preOrg` mode. Preserve the option for the existing
organization flow. After unified onboarding creates the organization and app,
the dedicated setup step remains responsible for provisioning the key and
showing the real terminal command.

Add a focused regression assertion to the existing onboarding API-key loading
unit test. The assertion verifies that the shared terminal-option container is
guarded by `!props.preOrg`. No API-key provisioning, onboarding sequencing, or
copy behavior changes.

## Verification

Run the focused onboarding unit test through a red-green cycle, then run the
repository frontend lint, unit-test, typecheck, and production-build commands.
