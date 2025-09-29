import pino, { type LoggerOptions } from 'pino';

import { config } from './env';

export type Logger = pino.Logger;

const createJsonTransport = () =>
  pino.transport({
    targets: [
      {
        target: 'pino/file',
        level: config.logLevel,
        options: { destination: 1, mkdir: false },
      },
    ],
  });

const isMissingPrettyTransportError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('pino-pretty');
};

const buildTransport = () => {
  if (config.logTransport === 'pretty') {
    try {
      return pino.transport({
        targets: [
          {
            target: 'pino-pretty',
            level: config.logLevel,
            options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
          },
        ],
      });
    } catch (error) {
      if (!isMissingPrettyTransportError(error)) {
        throw error;
      }

      console.warn(
        'pino-pretty transport is unavailable. Falling back to JSON logging. ' +
          'Install pino-pretty or set PINO_TRANSPORT=json to silence this warning.',
      );
    }
  }

  return createJsonTransport();
};

const createRateLimitHook = (limit: number): LoggerOptions['hooks'] | undefined => {
  if (!Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }

  let windowStart = Date.now();
  let emitted = 0;

  return {
    logMethod(this: Logger, args, method, level) {
      if (level >= 40) {
        method.apply(this, args);
        return;
      }

      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        emitted = 0;
      }

      if (emitted >= limit) {
        return;
      }

      emitted += 1;
      method.apply(this, args);
    },
  } satisfies LoggerOptions['hooks'];
};

const transport = buildTransport();

const loggerOptions: LoggerOptions = {
  level: config.logLevel,
  base: {
    service: 'freedom-bot',
    environment: config.nodeEnv,
  },
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const rateLimitHooks = createRateLimitHook(config.logRateLimit);
if (rateLimitHooks) {
  loggerOptions.hooks = rateLimitHooks;
}

export const logger: Logger = pino(loggerOptions, transport);
