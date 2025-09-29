import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../config';
import { pool } from './client';
import type { PoolClient } from './client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const MIGRATION_EXTENSION = '.up.sql';
const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    file_name TEXT PRIMARY KEY,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
const CHECK_MIGRATION_SQL = 'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE file_name = $1) AS exists';
const RECORD_MIGRATION_SQL = 'INSERT INTO schema_migrations (file_name) VALUES ($1)';

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

const applyMigration = async (client: PoolClient, fileName: string): Promise<void> => {
  const sql = await loadMigrationSql(fileName);
  await client.query(sql);
  await client.query(RECORD_MIGRATION_SQL, [fileName]);
};

const ensureSchema = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query(CREATE_MIGRATIONS_TABLE_SQL);
    const migrations = await loadMigrationFiles();

    for (const fileName of migrations) {
      const { rows } = await client.query<{ exists: boolean }>(CHECK_MIGRATION_SQL, [fileName]);
      const exists = rows[0]?.exists ?? false;

      if (exists) {
        continue;
      }

      logger.info({ migration: fileName }, 'Applying database migration');
      await applyMigration(client, fileName);
    }

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
