import type { Request, Response } from 'express';

import { logger } from '../config';
import { getGitRevision } from '../lib/git';
import { metricsSnapshot } from '../metrics/prometheus';
import { pool } from '../db';
import { isDatabaseFallbackActive } from '../app';
import { isDatabaseSchemaReady } from '../db/bootstrap';
import { version } from '../../package.json';

type DatabaseStatus = 'up' | 'down';
type SchemaStatus = 'ok' | 'mismatch';
type SafeModeStatus = 'on' | 'off';

interface HealthResponse {
  ok: boolean;
  version: string;
  revision: string;
  timestamp: string;
  db: DatabaseStatus;
  schema: SchemaStatus;
  safe_mode: SafeModeStatus;
}

let lastDatabaseStatus: DatabaseStatus | null = null;

const checkDatabaseStatus = async (): Promise<DatabaseStatus> => {
  try {
    await pool.query('SELECT 1');
    if (lastDatabaseStatus === 'down') {
      logger.info('Database connectivity restored during health probe');
    }
    lastDatabaseStatus = 'up';
    return 'up';
  } catch (error) {
    if (lastDatabaseStatus !== 'down') {
      logger.error({ err: error }, 'Database health probe failed');
    }
    lastDatabaseStatus = 'down';
    return 'down';
  }
};

const resolveSchemaStatus = (): SchemaStatus => (isDatabaseSchemaReady() ? 'ok' : 'mismatch');

const resolveSafeModeStatus = (): SafeModeStatus => (isDatabaseFallbackActive() ? 'on' : 'off');

const buildHealthResponse = async (): Promise<HealthResponse> => {
  const [dbStatus, schemaStatus, safeModeStatus] = await Promise.all([
    checkDatabaseStatus(),
    Promise.resolve(resolveSchemaStatus()),
    Promise.resolve(resolveSafeModeStatus()),
  ]);

  const body: HealthResponse = {
    ok: dbStatus === 'up' && schemaStatus === 'ok' && safeModeStatus === 'off',
    version,
    revision: getGitRevision(),
    timestamp: new Date().toISOString(),
    db: dbStatus,
    schema: schemaStatus,
    safe_mode: safeModeStatus,
  };

  return body;
};

export const healthHandler = async (_req: Request, res: Response): Promise<void> => {
  const body = await buildHealthResponse();
  res.status(body.ok ? 200 : 503).json(body);
};

export const readinessHandler = async (req: Request, res: Response): Promise<void> => {
  const body = await buildHealthResponse();

  if (!body.ok) {
    res.status(503).json(body);
    return;
  }

  try {
    await metricsSnapshot();
    res.status(200).json(body);
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect metrics snapshot during readiness probe');
    res.status(503).json({ ...body, ok: false });
  }
};
