# Database migrations

The service ships with SQL migrations stored in [`db/migrations`](./migrations).
They are applied automatically when the application calls
`ensureDatabaseSchema()` (this happens on startup) or can be executed manually
with:

```sh
npm run db:migrate
```

The migration runner applies all `*.up.sql` files in lexical order and records
their execution in the `schema_migrations` table. Down migrations are provided
solely for local development resets.

## Current migration set

| File | Purpose |
| ---- | ------- |
| `0001_initial.up.sql` | Bootstraps the complete production schema, including tables, enums, sequences and indexes. |
| `0002_add_flow_state_index.up.sql` | Keeps a concurrent creation path for the `sessions_scope_state_idx` index when upgrading an existing database. New installations already receive the index from migration 0001. |
| `0006_update_recent_locations_schema.up.sql` | Expands `user_recent_locations` to track multiple entries per user/city/kind combination and aligns the types with the application service. |
| `0008_add_user_foreign_keys.up.sql` | Adds cascading foreign keys from analytics and cache tables to `users(tg_id)` to keep auxiliary data in sync. |
| `0009_activate_verified_clients.up.sql` | Promotes phone-verified users stuck in onboarding to the `active_client` status and stores their previous status for easy rollback. |

If your database is empty, running the migrations once is sufficient — both
files will be executed and the second one becomes a no-op after the index
exists. On production data the second migration remains safe because it uses
`IF NOT EXISTS` together with `CREATE INDEX CONCURRENTLY` to avoid locking the
`sessions` table during the upgrade.

## Notes on migration 0006

Migration `0006_update_recent_locations_schema.up.sql` removes all rows from
`user_recent_locations` before restructuring the table. The previous schema
stored only a single location per user, so the data cannot be migrated into the
new multi-location format in a meaningful way. The next user interaction will
recreate the entries with the richer structure.

## Maintaining referential integrity

Before applying migration `0008_add_user_foreign_keys.up.sql` on a live
database, run orphan checks to make sure analytics tables do not reference
removed users:

```sql
SELECT user_id
FROM recent_actions ra
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.tg_id = ra.user_id)
LIMIT 20;
```

Repeat the same pattern for `user_experiments`, `ui_events`, and
`user_recent_locations`. Clean up any rows returned by the queries to prevent
the foreign keys from failing during the migration.
