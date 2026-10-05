# CLI AI Prompt Intents Design

## Goal

Allow links to `/login-cli?ai=1` to include an onboarding `intent` so the copied AI prompt matches the user's goal. Preserve the existing OTA setup prompt when `intent` is absent or unsupported, while making Capgo Builder's MCP onboarding discoverable.

The functional change must stay below 200 lines, excluding prompt copy, documentation, and tests.

## Supported URLs

| Query | Result |
| --- | --- |
| No `intent` | Existing OTA prompt |
| `intent=ota` | Existing OTA prompt |
| `intent=builder` | Builder MCP prompt |
| `intent=both` | Choose-first prompt |
| `intent=exploring` | Same choose-first prompt |
| Any unsupported value | Existing OTA prompt |

`ai=1` remains the only switch that enables AI prompt mode. The visible page title, description, caption, and controls remain generic and unchanged for every intent.

## Architecture

Prompt selection belongs in `src/services/cliAiPrompt.ts`, not in the Vue page. The service normalizes the untrusted route query value to `ota`, `builder`, `both`, or `exploring`, defaulting to `ota`.

`src/pages/login-cli.vue` continues to gather the prepared API key and eligible organization/app context. It passes `route.query.intent` to the prompt builder and does not contain product-specific prompt policy.

The existing `buildCliAiSetupPrompt` entry point remains backward-compatible. Calling it without an intent must produce the existing OTA prompt unchanged.

## Prompt Composition

### Shared authentication

Every generated prompt contains the prepared API key exactly once, in the existing positional CLI login command. Authentication happens before either product flow so the credential is saved locally and survives an AI client restart.

The existing OTA authentication wording and eight-part OTA output remain unchanged. Builder and choose-first variants may use intent-specific transition wording after the shared authentication requirements.

### OTA

The OTA path is the current eight-section AI-led setup prompt. This path must remain unchanged for absent, invalid, and explicit `ota` intents.

### Builder

After authenticating, the AI must:

1. Determine the current supported MCP client, asking the user only if it cannot identify the client safely.
2. Install Capgo MCP through the public `npx install-mcp 'npx @capgo/cli@latest mcp' --client <client>` command shape.
3. Verify whether the newly installed Capgo MCP tools are available.
4. If the client requires a restart, tell the user to restart it and explain how to resume Capgo Builder setup afterward. Do not pretend the new tools are available before restart.
5. Once the tools are available, call `start_capgo_builder_onboarding` immediately.
6. Follow every returned `next` instruction and use `capgo_builder_onboarding_next_step` or `capgo_builder_onboarding_explain` exactly as directed until the flow completes.

The prompt forbids manually reimplementing Builder onboarding, inspecting configuration as a substitute for the MCP flow, or claiming success without the onboarding tool's completion result.

### Both and exploring

`both` and `exploring` intentionally produce the same prompt. After authentication, the AI asks: “What would you like to configure first: Capgo Live Updates or Capgo Builder?” It waits for the answer before starting either path.

- If the user chooses Live Updates, follow the existing OTA prompt first.
- If the user chooses Builder, install/use MCP and start Builder onboarding first.
- After the selected flow completes, offer to configure the other product.
- Do not start both flows concurrently.

Both complete instruction sets are included in the prompt, but the API key appears only once in the shared authentication section.

## Error Handling and Compatibility

- Treat query strings as untrusted input and accept only exact supported values.
- Arrays, missing values, and unknown strings resolve to `ota`.
- Do not show an error for an unsupported intent; fallback is deliberate backward compatibility.
- Key preparation, eligible organization filtering, key reuse, copy behavior, and non-AI browser login remain unchanged.
- Builder MCP installation failures must be reported honestly. The AI should diagnose the installation or ask the user for the missing client choice rather than falling back to manual Builder setup.
- A required restart is a normal pause, not a successful installation-and-onboarding completion.

## Testing

Pure prompt tests will verify:

- absent, explicit `ota`, and invalid intents produce the existing OTA prompt;
- `builder` contains authentication, MCP installation, restart handling, and `start_capgo_builder_onboarding` instructions;
- `both` and `exploring` produce the same choose-first behavior;
- the combined prompt asks which product to configure first and offers the other afterward;
- every prompt contains the API key exactly once;
- user-controlled organization and app names retain the current sanitization guarantees.

Page tests will verify that `route.query.intent` reaches the prompt builder while the visible generic AI copy and non-AI behavior remain unchanged.

Focused unit tests, lint for touched files, and TypeScript validation will be run before opening the pull request.

## Scope

This change makes the console URL intent-aware. Updating external marketing-site links to append an intent is a separate caller change unless that source is present in this repository. No database, backend, MCP server, or visual redesign is required.
