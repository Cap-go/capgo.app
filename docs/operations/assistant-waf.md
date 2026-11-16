# Assistant requests blocked by Cloudflare WAF

The browser assistant posts conversation text and MCP tool descriptions to
`POST https://api.capgo.app/private/assistant/responses`. These contain legitimate
CLI command examples. Cloudflare's managed **Command Injection - Common Attack
Commands** rule (`64fa151963064ea09fc8a7df851d2f71`) has blocked these requests
before the API Worker runs. This was confirmed by correlating a reproduced 403's
CF-Ray with a `firewallManaged` security event for that rule. A minimal synthetic
request without credentials reaches the Worker and gets JSON 401. Adding a tool
description containing a `curl -fsS -X PUT` upload example changes it to an HTML
403 without CORS headers. No customer data is needed to reproduce it.

The edge returns HTML without the console's CORS headers, so JavaScript receives
a fetch failure and DevTools may show “Failed to load response data”. Changing
OpenAI tokens, models or the Worker proxy cannot fix a request stopped at the WAF.

## Apply the scoped exception

Use a Cloudflare token with Zone WAF Read for preview, or Zone WAF Edit for apply,
scoped to the `capgo.app` zone. Set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ZONE_ID` through your normal secret environment. Do not put tokens or
customer payloads in this repository or command output.

```sh
bun scripts/setup-assistant-waf.ts --dry-run
bun scripts/setup-assistant-waf.ts --apply
```

Preview is the default. The script checks the live managed catalog and deployment,
then creates or patches only the rule with ref `capgo_assistant_command_examples`.
It inserts the exception before the managed ruleset executes, verifies it by
reading the entrypoint again, and does nothing on subsequent runs if it matches.
It never replaces the entrypoint or modifies other rules/overrides.

The exception skips **only that one rule**, only for the exact assistant responses
path on `api.capgo.app`, method POST, content type `application/json`. Other WAF
checks, rate limits, bot checks and routes remain unchanged. The Worker still
requires an authenticated console JWT, validates the ChatGPT token and JSON
payload, imposes its 1 MiB limit, and only forwards to the fixed OpenAI endpoint.
The assistant does not execute shell commands from the conversation.

Merging this PR or deploying the Worker does **not** apply this zone configuration.
Run the setup separately. This exception is specific to `api.capgo.app`; investigate
security events before extending it to other hostnames or rules.

## Verify and roll back

After applying, send a harmless greeting in the signed-in console assistant.
Confirm the request reaches the Worker and completes a Responses stream. A JSON
provider error is a separate issue: inspect its status/code and preserve the request
ID rather than assuming every 403 is this WAF rule. Confirm unauthorized requests
still return 401 and other endpoints retain their protections.

Rollback: delete only the exception whose ref is `capgo_assistant_command_examples`
from the zone's managed WAF entrypoint. The apply result prints its rule ID. Use
Cloudflare's Rulesets API `DELETE /zones/{zone_id}/rulesets/{entrypoint_id}/rules/{rule_id}`
or remove that exception in the dashboard. Do not disable the managed ruleset.

Reference: [Cloudflare managed WAF exceptions via API](https://developers.cloudflare.com/waf/managed-rules/waf-exceptions/define-api/).
