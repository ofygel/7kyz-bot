import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';

interface InitSentryOptions {
  readonly dsn?: string;
  readonly expressApp: Express;
  readonly tracesSampleRate?: number;
  readonly environment?: string;
  readonly release?: string;
}

interface SentryHandlers {
  readonly requestHandler: RequestHandler;
  readonly tracingHandler: RequestHandler;
  readonly errorHandler: ErrorRequestHandler;
}

export const initSentry = (options: InitSentryOptions): SentryHandlers | null => {
  const { dsn, expressApp, tracesSampleRate, environment, release } = options;

  if (!dsn) {
    return null;
  }

  Sentry.init({
    dsn,
    tracesSampleRate: tracesSampleRate ?? 0.1,
    integrations: [
      new Tracing.Integrations.Postgres(),
      new Tracing.Integrations.Express({ app: expressApp }),
    ],
    environment: environment ?? process.env.NODE_ENV ?? 'development',
    release: release ?? process.env.RELEASE ?? 'unknown',
  });

  return {
    requestHandler: Sentry.Handlers.requestHandler(),
    tracingHandler: Sentry.Handlers.tracingHandler(),
    errorHandler: Sentry.Handlers.errorHandler(),
  };
};
