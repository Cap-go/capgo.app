### Adding Supabase Migration

To make changes to the database schema in your Supabase project, follow these steps to create and apply migrations:

1. **Create a New Migration:**

   Use the Supabase CLI to generate a new migration file. Replace `migration_name` with a descriptive name for your migration.

```bash

supabase migration new migration_name

```
This will create a new migration file in the `migrations` directory.

2. **Edit The Migrations File**

Open the newly created migration file in the `migrations` directory. Inside this file, define the changes you want to make to the database schema. You can create tables, add columns, modify constraints, and perform other schema-related tasks.

Be careful when editing migration files and ensure that your changes are correct. Migrations are versioned, and incorrect changes can lead to database inconsistencies.


3. **Test Locally:**

Before pushing your migration to the main branch, it's a good practice to test it locally. Use the Supabase CLI to apply the migration to your local development database to verify that it works as expected.


```bash

supabase migration up

```

Replace `$LOCAL_DATABASE_URL` with the URL of your local development database.


4. **Run Local Supabase DB:**

Before running migrations locally, make sure you have the local Supabase DB running. Use the following command to start the Supabase DB:
   
```bash

bun run supabase:start

```
If the command completes successfully, your console output should provide details about the locally running Supabase instance.


5. **Commit and Push:**

Once you're confident that the migration works correctly, commit the migration file and push it to your GitHub repository's `main` branch.

**Important:** Once a migration has been pushed to the main branch, it should be treated as immutable. Do not modify existing migrations from the main branch to make corrections or updates. Instead, create new migrations to address any issues or changes to the database schema.

6. **Automated Deployment:**

Our CI/CD workflow will automatically deploy the migration to the production database when changes are pushed to the `main` branch. You don't need to manually apply migrations on the production database


7. **Reset Local Supabase DB (Optional):**

If needed, you can reset the local Supabase DB to its initial state. Use the following command to reset the local database:
   
```bash

supabase db reset

```

This command will clear all data and revert schema changes made to the local database, restoring it to its initial state.


By following these steps, you can safely add and deploy Supabase migration changes to your project's database schema.

## Vanilla Postgres 17 (Phase 0 compatibility path)

Capgo keeps the Supabase CLI as the migration runner. For Phase 0 of leaving the full
Supabase Docker stack, you can apply the same `supabase/migrations/` tree against a
plain `postgres:17` container. This is **additive**: `bun run supabase:start` remains
the default local path.

### Start vanilla Postgres

```bash
bun run postgres:vanilla:up
```

`docker-compose.yml` exposes Postgres on `127.0.0.1:5432` with:

- user: `postgres`
- password: `postgres`
- database: `capgo`

### Apply migrations

```bash
bun run postgres:vanilla:push
```

This runs `bunx supabase db push --db-url postgresql://postgres:postgres@127.0.0.1:5432/capgo?sslmode=disable`
and writes a timestamped log under `.context/vanilla-postgres/`.

Override the URL when needed:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/capgo bun run postgres:vanilla:push
```

### Create new migrations (unchanged)

```bash
bunx supabase migration new <feature_slug>
```

Edit the generated file under `supabase/migrations/`, test on the full Supabase stack
with `bun run supabase:db:reset`, and optionally re-run `bun run postgres:vanilla:push`
to see what still depends on Supabase-only pieces.

### Known gaps on vanilla Postgres

See [vanilla_postgres_inventory.md](./vanilla_postgres_inventory.md) for the categorized
inventory from the Phase 0 apply attempt (extensions, auth/storage schemas, roles, hooks,
queues). Expect the baseline squash migration to fail early without Supabase extensions
and platform schemas.
