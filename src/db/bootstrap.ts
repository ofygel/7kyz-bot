import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../config';
import { pool } from './client';
import type { PoolClient } from './client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const MIGRATION_EXTENSION = '.up.sql';
const REQUIRED_SCHEMA_VERSION = '0100_baseline.up.sql';
const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    file_name TEXT PRIMARY KEY,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
const CHECK_MIGRATION_SQL = 'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE file_name = $1) AS exists';
const RECORD_MIGRATION_SQL = 'INSERT INTO schema_migrations (file_name) VALUES ($1)';
const FIND_LEGACY_MIGRATIONS_SQL = `
  SELECT file_name AS legacy
  FROM schema_migrations
  WHERE file_name < $1
  ORDER BY file_name
`;

const CHECK_BASELINE_SCHEMA_SQL = `
  SELECT
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname = 'executor_kind'
    ) AS has_executor_kind,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'users'
        AND c.relkind = 'r'
    ) AS has_users_table,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'orders'
        AND c.relkind = 'r'
    ) AS has_orders_table
`;

let schemaReady = false;
let bootstrapPromise: Promise<void> | null = null;
let cachedMigrations: string[] | null = null;
const migrationSqlCache = new Map<string, string>();

const loadMigrationFiles = async (): Promise<string[]> => {
  if (cachedMigrations) {
    return cachedMigrations;
  }

  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(MIGRATION_EXTENSION))
    .map((entry) => entry.name)
    .sort();

  cachedMigrations = migrations;
  return migrations;
};

const loadMigrationSql = async (fileName: string): Promise<string> => {
  const cached = migrationSqlCache.get(fileName);
  if (cached) {
    return cached;
  }

  const filePath = path.join(MIGRATIONS_DIR, fileName);
  const sql = await readFile(filePath, 'utf-8');
  migrationSqlCache.set(fileName, sql);
  return sql;
};

const recordMigration = async (client: PoolClient, fileName: string): Promise<void> => {
  await client.query(RECORD_MIGRATION_SQL, [fileName]);
};

const applyMigration = async (client: PoolClient, fileName: string): Promise<void> => {
  const sql = await loadMigrationSql(fileName);
  await client.query(sql);
  await recordMigration(client, fileName);
};

const removeLegacyMigrationEntries = async (client: PoolClient): Promise<void> => {
  const { rows } = await client.query<{ legacy: string }>(FIND_LEGACY_MIGRATIONS_SQL, [
    REQUIRED_SCHEMA_VERSION,
  ]);

  if (rows.length === 0) {
    return;
  }

  const legacyMigrations = rows.map((row) => row.legacy);
  logger.warn(
    { legacyMigrations },
    'Removing legacy migration entries prior to baseline migration.',
  );

  await client.query(`DELETE FROM schema_migrations WHERE file_name = ANY($1::text[])`, [
    legacyMigrations,
  ]);
};

const hasBaselineSchema = async (client: PoolClient): Promise<boolean> => {
  const { rows } = await client.query<{
    has_executor_kind: boolean;
    has_users_table: boolean;
    has_orders_table: boolean;
  }>(CHECK_BASELINE_SCHEMA_SQL);

  const baseline = rows[0];
  return Boolean(
    baseline?.has_executor_kind && baseline?.has_users_table && baseline?.has_orders_table,
  );
};

const ensureSchema = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query(CREATE_MIGRATIONS_TABLE_SQL);
    await removeLegacyMigrationEntries(client);
    const migrations = await loadMigrationFiles();

    for (const fileName of migrations) {
      const { rows } = await client.query<{ exists: boolean }>(CHECK_MIGRATION_SQL, [fileName]);
      const exists = rows[0]?.exists ?? false;

      if (exists) {
        continue;
      }

      if (fileName === REQUIRED_SCHEMA_VERSION && (await hasBaselineSchema(client))) {
        logger.info(
          { migration: fileName },
          'Detected existing baseline schema. Recording migration without reapplying SQL.',
        );
        await recordMigration(client, fileName);
        continue;
      }

      logger.info({ migration: fileName }, 'Applying database migration');
      await applyMigration(client, fileName);
    }

    const { rows: versionRows } = await client.query<{ exists: boolean }>(CHECK_MIGRATION_SQL, [
      REQUIRED_SCHEMA_VERSION,
    ]);
    if (!versionRows[0]?.exists) {
      throw new Error(
        `Database schema is outdated. Expected migration ${REQUIRED_SCHEMA_VERSION} to be applied.`,
      );
    }

    await removeLegacyMigrationEntries(client);

    schemaReady = true;
  } finally {
    client.release();
  }
};

export const ensureDatabaseSchema = async (): Promise<void> => {
  if (schemaReady) {
    return;
  }

  if (!bootstrapPromise) {
    bootstrapPromise = ensureSchema()
      .catch((error) => {
        logger.error({ err: error }, 'Failed to ensure database schema');
        throw error;
      })
      .finally(() => {
        bootstrapPromise = null;
      });
  }

  await bootstrapPromise;

  if (!schemaReady) {
    throw new Error('Database schema initialisation failed');
  }
};

export const isDatabaseSchemaReady = (): boolean => schemaReady;

/**
 * Testing helper used to reset the bootstrap state between test cases.
 * Not intended for production use.
 */
export const resetDatabaseSchemaCache = (): void => {
  schemaReady = false;
  bootstrapPromise = null;
  cachedMigrations = null;
  migrationSqlCache.clear();
};
