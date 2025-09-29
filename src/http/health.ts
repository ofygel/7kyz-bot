import type { Request, Response } from 'express';

import { logger } from '../config';
import { getGitRevision } from '../lib/git';
import { metricsSnapshot } from '../metrics/prometheus';
import { version } from '../../package.json';

interface HealthResponse {
  ok: true;
  version: string;
  revision: string;
  timestamp: string;
}

export const healthHandler = (_req: Request, res: Response): void => {
  const body: HealthResponse = {
    ok: true,
    version,
    revision: getGitRevision(),
    timestamp: new Date().toISOString(),
  };

  res.status(200).json(body);
};

export const readinessHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    await metricsSnapshot();
    healthHandler(req, res);
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect metrics snapshot during readiness probe');
    res.status(503).json({ ok: false });
  }
};
