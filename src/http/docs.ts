import type { Request, Response } from 'express';

import { getGitRevision } from '../lib/git';
import { version } from '../../package.json';

const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Freedom Bot Service API',
    version,
  },
  servers: [
    {
      url: 'https://example.com',
      description: 'Placeholder server URL, replace with deployment domain',
    },
  ],
  paths: {
    '/healthz': {
      get: {
        summary: 'Health probe',
        description: 'Returns service status alongside build metadata.',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', enum: [true] },
                    version: { type: 'string', example: version },
                    revision: { type: 'string', example: getGitRevision() },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                  required: ['ok', 'version', 'revision', 'timestamp'],
                },
              },
            },
          },
        },
      },
    },
    '/metrics': {
      get: {
        summary: 'Prometheus metrics',
        description: 'Exposes runtime metrics in Prometheus exposition format.',
        responses: {
          '200': {
            description: 'Metrics payload',
            content: {
              'text/plain': {
                schema: {
                  type: 'string',
                  example: '# HELP telegram_updates_total Total updates processed\n',
                },
              },
            },
          },
        },
      },
    },
  },
};

export const openApiHandler = (_req: Request, res: Response): void => {
  res.status(200).json(openApiDocument);
};
