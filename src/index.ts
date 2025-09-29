import express from 'express';
import rateLimit from 'express-rate-limit';
import type { Server } from 'http';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import type { Update } from 'telegraf/types';

import {
  app,
  initialiseAppState,
  isShutdownInProgress,
  registerCleanupTask,
  setupGracefulShutdown,
} from './app';
import { config, logger } from './config';
import { healthHandler, readinessHandler } from './http/health';
import { metricsHandler } from './http/metrics';
import { openApiHandler } from './http/docs';
import { registerJobs, stopJobs } from './jobs';
import { initSentry } from './infra/sentry';

const gracefulShutdownErrorPatterns = [
  /bot is not running/i,
  /bot has not been started/i,
  /stop\s+.*before\s+start/i,
];

const normaliseError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const isAbortSignalError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown };

  if (candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR') {
    return true;
  }

  return false;
};

const matchesGracefulShutdownMessage = (message: unknown): boolean =>
  typeof message === 'string' && gracefulShutdownErrorPatterns.some((pattern) => pattern.test(message));

const isGracefulShutdownError = (error: unknown): boolean => {
  if (isAbortSignalError(error)) {
    return true;
  }

  if (typeof error === 'string') {
    return matchesGracefulShutdownMessage(error);
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown };
    if (matchesGracefulShutdownMessage(candidate.message)) {
      return true;
    }
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return matchesGracefulShutdownMessage(error.message);
};

const removeTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

const buildWebhookConfig = (
  domain: string,
  secret: string,
): { path: string; url: string } => {
  const trimmedDomain = removeTrailingSlashes(domain);
  const path = `/bot/${secret}`;
  return {
    path,
    url: `${trimmedDomain}${path}`,
  };
};

const parsePort = (value: string | undefined): number => {
  if (!value) {
    return 3000;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('PORT must be a positive integer');
  }

  return parsed;
};

const parseTracesSampleRate = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('SENTRY_TRACES_SAMPLE_RATE must be a number between 0 and 1');
  }

  return parsed;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const asyncHandler = (
  handler: (req: Request, res: Response) => Promise<void>,
): ((req: Request, res: Response, next: NextFunction) => void) =>
  (req: Request, res: Response, next: NextFunction): void => {
    // eslint-disable-next-line promise/no-callback-in-promise
    void handler(req, res).catch(next);
  };

const startServer = async (webhookPath: string, port: number): Promise<Server> => {
  const serverApp = express();
  serverApp.set('trust proxy', 1);

  const sentryHandlers = initSentry({
    dsn: process.env.SENTRY_DSN,
    expressApp: serverApp,
    tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    environment: process.env.NODE_ENV,
    release: process.env.RELEASE,
  });

  if (sentryHandlers) {
    serverApp.use(sentryHandlers.requestHandler);
    serverApp.use(sentryHandlers.tracingHandler);
  }

  serverApp.use(helmet());
  serverApp.use(cors({ origin: false }));
  serverApp.use(express.json({ limit: '1mb' }));
  serverApp.use(
    rateLimit({
      windowMs: 60_000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  serverApp.post(webhookPath, (req: Request<unknown, unknown, Update>, res: Response) => {
    void app.handleUpdate(req.body);
    res.sendStatus(200);
  });

  serverApp.get('/health', healthHandler);
  serverApp.get('/healthz', healthHandler);
  serverApp.get('/readiness', asyncHandler(readinessHandler));
  serverApp.get('/readyz', asyncHandler(readinessHandler));
  serverApp.get('/metrics', asyncHandler(metricsHandler));
  serverApp.get('/openapi.json', openApiHandler);

  if (sentryHandlers) {
    serverApp.use(sentryHandlers.errorHandler);
  }

  return await new Promise<Server>((resolve, reject) => {
    const httpServer = serverApp.listen(port, '0.0.0.0', () => {
      resolve(httpServer);
    });

    httpServer.on('error', (error) => {
      httpServer.close();
      reject(error);
    });
  });
};

const start = async (): Promise<void> => {
  let server: Server | null = null;
  try {
    await initialiseAppState();
    const { url, path } = buildWebhookConfig(config.webhook.domain, config.webhook.secret);
    const port = parsePort(process.env.PORT);

    server = await startServer(path, port);
    const httpServer = server;
    logger.info({ port }, 'Webhook server listening for updates');

    try {
      await app.telegram.setWebhook(url);
    } catch (webhookError) {
      await closeServer(httpServer).catch((error) => {
        logger.error({ err: normaliseError(error) }, 'Failed to close webhook server after registration error');
      });
      server = null;
      throw webhookError;
    }

    registerCleanupTask(() => closeServer(httpServer));

    registerJobs(app);
    registerCleanupTask(() => {
      stopJobs();
    });

    logger.info({ url }, 'Webhook registered');
    logger.info({ port, path }, 'Bot started using webhook');
  } catch (error) {
    if (server) {
      await closeServer(server).catch((closeError) => {
        logger.error({ err: normaliseError(closeError) }, 'Failed to close webhook server during startup failure');
      });
    }

    if (isShutdownInProgress()) {
      logger.info({ err: error }, 'Bot stopped gracefully');
    } else if (isGracefulShutdownError(error)) {
      logger.info({ err: error }, 'Bot stopped gracefully');
    } else {
      logger.fatal({ err: error }, 'Failed to start bot or jobs');
      process.exitCode = 1;
    }
  }
};

setupGracefulShutdown(app);

void start();
