import type { Request, Response } from 'express';

import { logger } from '../config';
import { metricsRegistry, metricsSnapshot } from '../metrics/prometheus';

export const metricsHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const body = await metricsSnapshot();
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.status(200).send(body);
  } catch (error) {
    logger.error({ err: error }, 'Failed to serve Prometheus metrics');
    res.status(503).send('metrics_unavailable');
  }
};
