import { Pool, PoolClient } from 'pg';
import type { PoolConfig } from 'pg';

import { config, logger } from '../config';
import { observeDatabaseError } from '../metrics/prometheus';

const createSslOptions = (): PoolConfig['ssl'] => {
  if (!config.database.ssl) {
    return undefined;
  }

  return { rejectUnauthorized: false } satisfies NonNullable<PoolConfig['ssl']>;
};

const pool = new Pool({
  connectionString: config.database.url,
  ssl: createSslOptions(),
  max: config.database.pool.max,
  idleTimeoutMillis: config.database.pool.idleTimeoutMs,
  connectionTimeoutMillis: config.database.pool.connectionTimeoutMs,
  statement_timeout: config.database.pool.statementTimeoutMs,
  query_timeout: config.database.pool.queryTimeoutMs,
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected error from the database pool');
  observeDatabaseError();
});

export { pool };           // Named export (import { pool } from ...)
export default pool;       // Default export (import pool from ...)

export type TransactionCallback<T> = (client: PoolClient) => Promise<T>;
export interface TransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
}

export const withTx = async <T>(
  callback: TransactionCallback<T>,
  options: TransactionOptions = {},
): Promise<T> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    if (options.isolationLevel) {
      await client.query(
        `SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`
      );
    }

    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // eslint-disable-next-line no-console
      console.error('Failed to rollback transaction', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
};

export type { PoolClient } from 'pg';
