## Summary (AI generated)

- Add a Bento-backed trial usage recap email three days before trial end and a low-usage follow-up the day before.
- Remove the failed updates row from the usage recap achievement table. Failed updates still contribute to the low usage score but are not shown as a win.
- Replace mock legacy before screenshots with captures from real legacy Bento HTML (rendered via the preview script from the agent store paths; HTML not in the repo).

## Motivation (AI generated)

Trial emails need a clear before and after story and accurate product copy. We should not claim a time saved versus app store review number without measured wait time per org.

## Live Bento Trial workflow (AI generated)

| Item | Value |
| --- | --- |
| Workflow name | Trial |
| Automation id | `flow_yN0RXGeQOnDRslV6pBDKAnmr` |
| Trigger | `org:legacy_stripe_trial_started` |

Emails in order: day 7 Halfway, day 12 three days left, day 14 payment incoming (ends today), day 15 trial ended, day 18, day 23, day 28.

Other Bento lifecycle workflows also use templates named `lc_trial3`, `lc_today`, and `lc_expired`.

The new recap lines up with the legacy day 12 and day 14 messages. Pause those two steps in Bento when this ships so users do not get duplicate timing nudges. That pause is a Bento operations step, not part of this pull request.

## Time saved versus app store review (AI generated)

We do not have a measured app store review wait time per organization. Any headline number would be invented, so this pull request leaves that angle out.

## Screenshots (AI generated)

Before (legacy Bento body HTML, desktop then mobile):

- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/before-bento-3-days-left-desktop.png
- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/before-bento-3-days-left-mobile.png
- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/before-bento-ends-today-desktop.png
- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/before-bento-ends-today-mobile.png

After (new templates, desktop then mobile):

- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/trial-recap-usage-desktop.png
- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/trial-recap-usage-mobile.png
- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/trial-recap-low-usage-desktop.png
- https://raw.githubusercontent.com/Cap-go/capgo/9a0df13de0976afd838f75409de8152766492d4e/.github/pr-assets/trial-recap-low-usage-mobile.png

## Test plan (AI generated)

- [x] `bunx vitest run tests/trial-usage-recap.unit.test.ts`
- [ ] Upload new Bento templates and wire `org:trial_usage_recap` and `org:trial_end_usage_recap` in production.
- [ ] Pause legacy Trial workflow day 12 and day 14 sends when recap goes live.

## Business impact (AI generated)

Clearer trial messaging and fewer mismatched claims. Ops must pause overlapping legacy steps to avoid duplicate emails around the same trial dates.
