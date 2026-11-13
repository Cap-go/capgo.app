# Review information

The public review cases are in `plugin.json` under `extensions.com.openai.review.test_cases`. Uploading the package imports five positive and three negative cases. Keep reviewer identities, passwords, API keys, and private workspace details out of this repository and the ZIP.

## Reviewer access

Enter the dedicated demo account's login URL, tenant, username, password, and sign-in steps only in the OpenAI dashboard's private reviewer form. Use https://console.capgo.app/login.

Before submitting:

1. Sign in with exactly the saved reviewer credentials in a fresh private browser window. A working personal session does not verify the demo account. Stop if Capgo rejects the credentials.
2. Confirm that the account can immediately access its demo organization and sample apps, with the permissions and subscription access required by the cases. Review must not depend on account registration, pending invitations, an external MFA approval, or access to a private inbox.
3. Complete OAuth using that demo account and select only its demo organization. Do not connect a personal or customer workspace for review.
4. Run every imported case. Resolve app and channel identifiers through discovery. Empty channels, bundles, or telemetry must be explained without inventing resources or claiming success.
5. Supply an accessible recording of the tested workflows. Keep the account, sample data, and access working for later reviews.

The native version usage case does not require a cloud build. `capgo_get_build_status` requires both an accessible app ID and a real cloud `job_id`; it cannot list builds or determine that an app has no builds. If a later package adds a build-status or log case, prepare a sample job and provide its ID privately before submission.

## Package review cases

The five positive cases cover account and app discovery, channel state, uploaded bundles, Observe health, and native version usage. The three negative cases cover unavailable local files, inaccessible apps, and an unrelated request. They read sample state without deploying, sending notifications, or starting paid builds.

The manifest's publication object contains release notes. Leave reviewer credentials outside the package. An omitted demo recording URL preserves any existing dashboard value; it does not demonstrate that a recording exists or meets the review requirements.

## Submission

Follow https://developers.openai.com/plugins/deploy/submission. Save private review information, reconnect and rescan the deployed MCP server, and inspect every blocking finding before submitting. Approval and publication are separate steps; a successful ZIP upload or metadata scan does not mean the plugin is published.
