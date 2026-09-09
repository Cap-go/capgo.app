<!-- omit in toc -->

# Contributing to Capgo

First off, thanks for taking the time to contribute! ❤️

All types of contributions are encouraged and valued. Please make sure to read
the relevant section before making your contribution. It will make it a lot
easier for us maintainers and smooth out the experience for all involved. The
community looks forward to your contributions. 🎉

## Do not break already-published CLI versions

**Never ship backend or database changes that break the Capgo CLI version customers
already have installed.**

The CLI on customer machines is whatever was last published (`cli-<semver>` git tags
and `@capgo/cli` on npm). It does not update when we deploy the API or database.

If you change RPC grants, revoke `EXECUTE`, or alter API-key identity behavior, you
must keep the **last published CLI** working until a new CLI release stops using the
old path and customers have had time to upgrade.

CI enforces this in the job **`CRITICAL — Published CLI / do not break old CLI`**
(`tests/published-cli-rpc-contract.test.ts`). That job runs the **published** npm CLI
against your PR schema — not only the CLI built from your branch. Do not “fix” failing
contract tests by expecting permission denied; they are supposed to pass.

Typical regression: revoking `get_user_id(text)` for `anon` while published CLI still
calls `.rpc('get_user_id', { apikey })` with a valid API key. That broke production in
the past; the contract tests exist so it cannot happen again.

Oracle hardening (blocking anonymous callers from org-perm / invite RPCs) is intentional
and separate — see `tests/security-oracle-rpc-hardening.test.ts`.

## Running tests locally

This project uses a custom test runner located in
[tests_backend](https://github.com/Cap-go/capgo/tree/main/tests_backend). There
exists some requirements to run the tests:

- Having `bun` installed (Only for CLI tests)
- Having the [supabase cli](https://supabase.com/docs/guides/cli) installed
- Having a running supabase (`bun run supabase:start`)

The tests can be run with the following commands:

- `CLI_PATH=/home/user/CLI/ bun test:backend` (backend only)
- `CLI_PATH=/home/user/CLI/ bun test:cli` (cli only)
- `bun test:backend`

**Running tests locally WILL make changes to supabase**

After you submit a PR a contributor will run the full test suite on your
changes.

### Github capgo bot

There exists a bot that will run your tests if a capgo oranization member
requests it. You CANNOT run the test on the CI/CD by yourself if you do not have
merge permissions. If you want to run the tests on your change please ask
someone from the organization to do it
