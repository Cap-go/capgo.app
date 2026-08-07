---
name: starting-prod-frontend
description: Use only when the user explicitly invokes this skill or explicitly asks to start, run, or launch the local Capgo frontend against production.
---

# Start the Production-Backed Frontend

Start Capgo's local Vite frontend through the production Supabase proxy and report its URL.

## Invocation guard

Use this workflow only after an explicit request to start the server. Do not invoke it because a local frontend might be useful for debugging, testing, inspection, or another task.

Once explicitly invoked, start immediately without asking for confirmation.

## Workflow

1. Run `bun run serve:prod-no-cors` from the repository root in a persistent terminal session.
2. Wait until Vite prints its ready message and local URL. Allow Vite to select another port when the default is occupied.
3. Keep the terminal session running and report the exact local URL.

Do not open the URL in a browser. Do not print environment variables or credentials. If startup fails, report the useful error and do not fall back to `bun serve`, which bypasses the required Supabase proxy.
