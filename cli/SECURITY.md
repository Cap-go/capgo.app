# Security

Thanks for helping keep Capgo and `@capgo/cli` safe.

The live CLI source lives in this monorepo under `cli/` (`@capgo/cli` on npm). The standalone `Cap-go/CLI` repository is archived.

## Report a vulnerability for this repository

Do not use Discord, GitHub Issues, or any public forum.

Open a private advisory on the live monorepo (preferred):
https://github.com/Cap-go/capgo.app/security/advisories/new

Before you file, follow the Capgo reporting checklist in the org security policy:
https://github.com/Cap-go/.github/blob/main/SECURITY.md

## Org policy (canonical)

Reporting requirements, out-of-scope rules, what happens after you report, embargo, and bounty payout gates live in the Cap-go org security policy:
https://github.com/Cap-go/.github/blob/main/SECURITY.md

Public researcher pages:
- https://capgo.app/security/
- https://capgo.app/bug-bounty/

Paid open-source bounty eligibility is listed on https://capgo.app/bug-bounty/ (primarily the Capgo landing/website and `@capgo/capacitor-updater`). Always report CLI security issues privately here even when a cash bounty does not apply.

## Quick out-of-scope reminders

Reports in these classes are closed (see org policy and https://capgo.app/security/ for the full list):

- Unauthenticated `channel_self` set, and designed no-API-key behavior for `/updates` and `/stats`
- Uploader mislabeling encryption on `external_url` bundles
- Duplicates, already-fixed-on-`main` without a new exploit path, incomplete drafts

## Bounty

When a bounty applies, Capgo pays only after the fix is **released** and you have **verified** the fix. Linking or opening a PR alone is not enough. See https://capgo.app/bug-bounty/.
