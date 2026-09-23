---
name: organization-management
description: Use when working with Capgo account lookup, organization administration, member security settings, and deprecated organisation aliases.
---

# Capgo CLI Organization Management

Use this skill for account and organization administration commands.

## Account command

### `account id`

- Example: `npx @capgo/cli@latest account id`
- Use to retrieve an account ID that is safe to share for collaboration or support.
- Key option:
  - `-a, --apikey <apikey>`

## Organization commands

### `organization list`

- Alias: `l`
- Example: `npx @capgo/cli@latest organization list`
- Lists all organizations the current user can access.

### `organization add`

- Alias: `a`
- Example: `npx @capgo/cli@latest organization add --name "My Company" --email admin@mycompany.com`
- Key options:
  - `-n, --name <name>`
  - `-e, --email <email>`

### `organization members [orgId]`

- Alias: `m`
- Example: `npx @capgo/cli@latest organization members ORG_ID`
- Notes:
  - Lists members, roles, and 2FA status.
  - Useful before enabling 2FA enforcement.
  - Viewing 2FA status requires `super_admin` rights.

### `organization set [orgId]`

- Alias: `s`
- Example: `npx @capgo/cli@latest organization set ORG_ID --name "New Name"`
- Security examples:
  - `npx @capgo/cli@latest organization set ORG_ID --enforce-2fa`
  - `npx @capgo/cli@latest organization set ORG_ID --password-policy --min-length 12`
  - `npx @capgo/cli@latest organization set ORG_ID --require-apikey-expiration --max-apikey-expiration-days 90`
  - `npx @capgo/cli@latest organization set ORG_ID --enforce-hashed-api-keys`
- Notes:
  - Security settings require `super_admin` role.
- Key options:
  - `-n, --name <name>`
  - `-e, --email <email>`
  - `--enforce-2fa`, `--no-enforce-2fa`
  - `--password-policy`, `--no-password-policy`
  - `--min-length <minLength>`
  - `--require-uppercase`, `--no-require-uppercase`
  - `--require-number`, `--no-require-number`
  - `--require-special`, `--no-require-special`
  - `--require-apikey-expiration`, `--no-require-apikey-expiration`
  - `--max-apikey-expiration-days <days>`
  - `--enforce-hashed-api-keys`, `--no-enforce-hashed-api-keys`

### `organization delete [orgId]`

- Alias: `d`
- Example: `npx @capgo/cli@latest organization delete ORG_ID`
- Notes:
  - This action cannot be undone.
  - Only organization owners can delete organizations.

## Deprecated aliases

The `organisation` command group is deprecated in favor of `organization` and will be removed in a future version.

### Deprecated commands

- `organisation list`
- `organisation add`
- `organisation set [orgId]`
- `organisation delete [orgId]`

Use the `organization` equivalents for all new documentation and examples.

## Shared options

Most account and organization commands support:

- `-a, --apikey <apikey>`
