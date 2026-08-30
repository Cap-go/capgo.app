# CLI AI Prompt Intents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/login-cli?ai=1` generate OTA, Builder, or choose-first AI onboarding prompts from an optional `intent` query parameter while preserving the existing OTA default.

**Architecture:** Keep intent normalization and prompt composition in `src/services/cliAiPrompt.ts`. The Vue page passes the raw query value into the pure builder; exact supported values select a prompt, while missing, array, and unsupported values fall back to the existing OTA output.

**Tech Stack:** Vue 3, TypeScript, vue-router, Vitest, happy-dom, Bun.

---

## File Structure

- `src/services/cliAiPrompt.ts`: normalize intent and compose authentication, OTA, Builder MCP, and choose-first prompt sections.
- `src/pages/login-cli.vue`: pass `route.query.intent` to the prompt service without changing visible UI.
- `tests/cli-ai-prompt.unit.test.ts`: cover pure intent routing, prompt contracts, and secret handling.
- `tests/cli-login-page.unit.test.ts`: cover route-to-prompt wiring through the mounted page.

### Task 1: Add intent-aware prompt composition

**Files:**
- Modify: `tests/cli-ai-prompt.unit.test.ts`
- Modify: `src/services/cliAiPrompt.ts`

- [ ] **Step 1: Write failing prompt-routing tests**

Add a reusable input factory and these cases to `tests/cli-ai-prompt.unit.test.ts`:

```ts
function promptInput() {
  return {
    apiKey,
    organizations: [{
      id: 'org-1',
      name: 'Acme',
      apps: [{ appId: 'com.acme.app', name: 'Production App' }],
    }],
    skippedOrganizations: [],
  }
}

it.concurrent('keeps OTA as the default for absent and unsupported intents', () => {
  const existing = buildCliAiSetupPrompt(promptInput())

  expect(buildCliAiSetupPrompt(promptInput(), 'ota')).toBe(existing)
  expect(buildCliAiSetupPrompt(promptInput(), 'unknown')).toBe(existing)
  expect(buildCliAiSetupPrompt(promptInput(), ['builder'])).toBe(existing)
})

it.concurrent('builds the MCP-first Builder onboarding prompt', () => {
  const prompt = buildCliAiSetupPrompt(promptInput(), 'builder')

  expect(prompt.match(new RegExp(apiKey, 'g'))).toHaveLength(1)
  expect(prompt).toContain(`login ${apiKey}`)
  expect(prompt).toContain("npx install-mcp 'npx @capgo/cli@latest mcp' --client {MCP_CLIENT}")
  expect(prompt).toContain('restart the AI client')
  expect(prompt).toContain('start_capgo_builder_onboarding')
  expect(prompt).toContain('capgo_builder_onboarding_next_step')
  expect(prompt).not.toContain('## 8. Test the first live update')
})

it.concurrent('uses one choose-first prompt for both and exploring', () => {
  const both = buildCliAiSetupPrompt(promptInput(), 'both')
  const exploring = buildCliAiSetupPrompt(promptInput(), 'exploring')

  expect(exploring).toBe(both)
  expect(both.match(new RegExp(apiKey, 'g'))).toHaveLength(1)
  expect(both).toContain('What would you like to configure first: Capgo Live Updates or Capgo Builder?')
  expect(both).toContain('Do not start both setup flows concurrently.')
  expect(both).toContain('offer to configure the other product')
  expect(both).toContain('start_capgo_builder_onboarding')
  expect(both).toContain('## 8. Test the first live update')
})
```

- [ ] **Step 2: Run the prompt tests and verify they fail**

Run:

```bash
bunx vitest run tests/cli-ai-prompt.unit.test.ts
```

Expected: FAIL because `buildCliAiSetupPrompt` does not accept or route an intent and no Builder prompt exists.

- [ ] **Step 3: Make authentication continuation intent-aware without changing OTA output**

In `src/services/cliAiPrompt.ts`, add:

```ts
type AuthenticationDestination = 'ota' | 'builder' | 'choose-first'

const AUTHENTICATION_CONTINUATION: Record<AuthenticationDestination, string> = {
  ota: 'After authentication succeeds, continue to Section 2 and recommend the guided `init` flow.',
  builder: 'After authentication succeeds, continue to the Capgo MCP installation section. Do not configure Capgo Builder manually.',
  'choose-first': 'After authentication succeeds, ask which Capgo product I want to configure first. Do not begin either setup before I answer.',
}
```

Apply these two exact edits to the existing authentication template, leaving every other line intact:

```diff
-function buildAuthenticationSection(apiKey: string): string {
+function buildAuthenticationSection(apiKey: string, destination: AuthenticationDestination = 'ota'): string {

-- After authentication succeeds, continue to Section 2 and recommend the guided `init` flow.`
+- ${AUTHENTICATION_CONTINUATION[destination]}`
```

With the default `ota` destination, the generated text must equal the pre-change string exactly.

- [ ] **Step 4: Add Builder MCP and choose-first prompt sections**

Add these constants below the authentication section:

```ts
const BUILDER_MCP_SECTION = `## Install Capgo MCP and start Builder onboarding

Capgo Builder setup must be conducted through Capgo MCP. Do not configure signing, credentials, native builds, or store access manually.

Determine which supported MCP client you are currently running in. Use its install-mcp client identifier:

- Codex: \`codex\`
- Cursor: \`cursor\`
- Claude Code: \`claude-code\`
- Windsurf: \`windsurf\`
- VS Code: \`vscode\`
- Zed: \`zed\`

If you cannot identify the current client safely, ask me which client I use and wait for my answer.

Replace \`{MCP_CLIENT}\` with the chosen identifier and install Capgo MCP:

npx install-mcp 'npx @capgo/cli@latest mcp' --client {MCP_CLIENT}

After installation, check whether Capgo MCP tools are available in the current session.

- If the tools are unavailable until restart, tell me to restart the AI client. Do not pretend onboarding has started. Tell me that after restart I can say: “Continue Capgo Builder setup. Verify Capgo MCP is connected, then call start_capgo_builder_onboarding.” Stop and wait for the restart.
- If the tools are available without restart, continue immediately.

Once Capgo MCP is available, call \`start_capgo_builder_onboarding\` immediately. If I already named iOS or Android, pass that platform; otherwise omit it and let the tool ask.

Follow every result's \`next\` instruction exactly. Use \`capgo_builder_onboarding_next_step\` and \`capgo_builder_onboarding_explain\` only as directed until setup is complete. Do not replace the MCP flow with manual repository inspection or web research, and do not claim success unless the onboarding tools report completion.`

const CHOOSE_FIRST_SECTION = `## Choose what to configure first

Ask me this question exactly and wait for my answer:

“What would you like to configure first: Capgo Live Updates or Capgo Builder?”

Do not start both setup flows concurrently.

- If I choose Capgo Live Updates, follow the complete Live Updates branch below first.
- If I choose Capgo Builder, follow the complete Builder branch below first.
- After the selected setup completes, offer to configure the other product. Start it only if I agree.`
```

- [ ] **Step 5: Extract the existing OTA sections and route supported intents**

Keep the existing OTA constants and section builders unchanged. Replace only the final exported function with helpers equivalent to:

```ts
function otaSections(input: CliAiPromptInput): string[] {
  return [
    INIT_RECOMMENDATION_SECTION,
    buildOrganizationSection(input),
    CHANNEL_SECTION,
    PLUGIN_SECTION,
    NOTIFY_APP_READY_SECTION,
    FIRST_UPLOAD_SECTION,
    FIRST_UPDATE_TEST_SECTION,
  ]
}

function normalizeCliAiPromptIntent(value: unknown): 'ota' | 'builder' | 'both' | 'exploring' {
  return value === 'builder' || value === 'both' || value === 'exploring' || value === 'ota'
    ? value
    : 'ota'
}

export function buildCliAiSetupPrompt(input: CliAiPromptInput, rawIntent?: unknown): string {
  const intent = normalizeCliAiPromptIntent(rawIntent)
  if (intent === 'builder') {
    return [
      buildAuthenticationSection(input.apiKey, 'builder'),
      BUILDER_MCP_SECTION,
    ].join('\n\n')
  }

  if (intent === 'both' || intent === 'exploring') {
    return [
      buildAuthenticationSection(input.apiKey, 'choose-first'),
      CHOOSE_FIRST_SECTION,
      '# Capgo Live Updates branch',
      ...otaSections(input),
      '# Capgo Builder branch',
      BUILDER_MCP_SECTION,
    ].join('\n\n')
  }

  return [
    buildAuthenticationSection(input.apiKey),
    ...otaSections(input),
  ].join('\n\n')
}
```

- [ ] **Step 6: Run prompt tests and verify they pass**

Run:

```bash
bunx vitest run tests/cli-ai-prompt.unit.test.ts
```

Expected: all `buildCliAiSetupPrompt` tests PASS, including the existing name sanitization and one-secret assertions.

- [ ] **Step 7: Commit the prompt service and tests**

```bash
git add src/services/cliAiPrompt.ts tests/cli-ai-prompt.unit.test.ts
git commit -m "feat(frontend): add intent-aware CLI AI prompts"
```

### Task 2: Wire the route intent into the login page

**Files:**
- Modify: `tests/cli-login-page.unit.test.ts`
- Modify: `src/pages/login-cli.vue`

- [ ] **Step 1: Write the failing mounted-page test**

Add this test to `tests/cli-login-page.unit.test.ts`:

```ts
it('copies the Builder prompt when requested by route intent', async () => {
  route.query = { ai: '1', intent: 'builder' }
  const container = mountLoginCliPage()
  await flushPromises()

  const copyButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.includes(messages['cli-login-ai-copy']))
  copyButton?.click()
  await flushPromises()

  const copiedPrompt = clipboardWrite.mock.calls[0]?.[0] as string
  expect(copiedPrompt).toContain(`login ${preparedKey}`)
  expect(copiedPrompt).toContain('start_capgo_builder_onboarding')
  expect(copiedPrompt).not.toContain('## 8. Test the first live update')
})
```

Extend the static page contract assertion with:

```ts
expect(page).toContain('route.query.intent')
```

- [ ] **Step 2: Run the page test and verify it fails**

Run:

```bash
bunx vitest run tests/cli-login-page.unit.test.ts
```

Expected: FAIL because the page does not pass `route.query.intent`, so it copies the OTA prompt.

- [ ] **Step 3: Pass the raw query value to the prompt builder**

Change the `aiPrompt` computed value in `src/pages/login-cli.vue` to:

```ts
return buildCliAiSetupPrompt({
  apiKey: secret.value,
  organizations: aiPromptOrganizations.value,
  skippedOrganizations: aiPromptSkippedOrganizations.value,
}, route.query.intent)
```

Do not change `aiMode`, translations, template structure, key preparation, or the non-AI session flow.

- [ ] **Step 4: Run both focused test files**

Run:

```bash
bunx vitest run tests/cli-ai-prompt.unit.test.ts tests/cli-login-page.unit.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Commit the page wiring and test**

```bash
git add src/pages/login-cli.vue tests/cli-login-page.unit.test.ts
git commit -m "feat(frontend): route CLI AI prompt intent"
```

### Task 3: Verify the finished change

**Files:**
- Verify: `src/services/cliAiPrompt.ts`
- Verify: `src/pages/login-cli.vue`
- Verify: `tests/cli-ai-prompt.unit.test.ts`
- Verify: `tests/cli-login-page.unit.test.ts`

- [ ] **Step 1: Run the focused tests**

```bash
bunx vitest run tests/cli-ai-prompt.unit.test.ts tests/cli-login-page.unit.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 2: Run repository lint before validation**

```bash
bun lint
```

Expected: PASS with no lint errors.

- [ ] **Step 3: Run frontend type checking**

```bash
bun run typecheck:frontend
```

Expected: PASS with no TypeScript or Vue errors.

- [ ] **Step 4: Confirm scope and compatibility**

Run:

```bash
git diff 3346033bd --stat
git diff --check 3346033bd
git status --short
```

Expected: only the design/plan artifacts, prompt service, login page, and focused tests are changed by this work; `codedb.snapshot` remains an unrelated pre-existing modification and is not committed. No whitespace errors are reported.

- [ ] **Step 5: Inspect final prompt invariants**

Confirm from the focused tests that:

- no/invalid/`ota` intent returns the existing OTA prompt;
- `builder` installs MCP and calls `start_capgo_builder_onboarding`;
- `both` and `exploring` are identical choose-first prompts;
- all variants contain the API key exactly once;
- visible page copy and non-AI behavior remain unchanged.

- [ ] **Step 6: Prepare and open the pull request**

Invoke the repository-required `pr-ready` workflow, push the branch, and open a pull request whose title does not start with `[CODEX]`. Include the intent mapping and verification commands in the PR body.
