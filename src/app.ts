import { Telegraf } from 'telegraf';

import { registerBindCommand } from './bot/commands/bind';
import { registerStartCommand } from './bot/commands/start';
import { registerCityCommand } from './bot/commands/city';
import { registerHelpCommand } from './bot/commands/help';
import { registerDeliveryOrderFlow } from './bot/flows/client/deliveryOrderFlow';
import { registerClientMenu } from './bot/flows/client/menu';
import { registerClientSupport } from './bot/flows/client/support';
import { registerClientFallback } from './bot/flows/client/fallback';
import { registerClientOrdersFlow } from './bot/flows/client/orders';
import { registerTaxiOrderFlow } from './bot/flows/client/taxiOrderFlow';
import { registerSafeModeActions } from './bot/flows/common/safeMode';
import { registerExecutorMenu } from './bot/flows/executor/menu';
import { registerExecutorOrders } from './bot/flows/executor/orders';
import { registerExecutorSupport } from './bot/flows/executor/support';
import { registerExecutorRoleSelect } from './bot/flows/executor/roleSelect';
import { registerExecutorSubscription } from './bot/flows/executor/subscription';
import { registerExecutorVerification } from './bot/flows/executor/verification';
import { registerJoinRequests } from './bot/channels/joinRequests';
import { registerMembershipSync } from './bot/channels/membership';
import { registerOrdersChannel } from './bot/channels/ordersChannel';
import { registerChannelCommands } from './bot/channels/commands';
import {
  registerPaymentModerationQueue,
  restorePaymentModerationQueue,
} from './bot/moderation/paymentQueue';
import {
  registerVerificationModerationQueue,
  restoreVerificationModerationQueue,
} from './bot/moderation/verifyQueue';
import {
  registerSupportModerationBridge,
  restoreSupportThreads,
} from './bot/services/support';
import { auth } from './bot/middlewares/auth';
import { autoDelete } from './bot/middlewares/autoDelete';
import { errorBoundary } from './bot/middlewares/errorBoundary';
import { antiFlood } from './bot/middlewares/antiFlood';
import { session } from './bot/middlewares/session';
import { keyboardGuard } from './bot/middlewares/keyboardGuard';
import { stateGate } from './bot/middlewares/stateGate';
import { unknownHandler } from './bot/middlewares/unknown';
import { callbackDecoder } from './bot/middlewares/callbackDecoder';
import {
  ensurePhone,
  savePhone,
  PHONE_HELP_BUTTON_LABEL,
  PHONE_STATUS_BUTTON_LABEL,
  respondToPhoneHelp,
  respondToPhoneStatus,
} from './bot/flows/common/phoneCollect';
import { metricsCollector } from './bot/middlewares/metrics';
import { ensureVerifiedExecutor } from './bot/middlewares/verificationGate';
import type { BotContext } from './bot/types';
import { config, logger } from './config';
import { pool } from './db';
import { ensureDatabaseSchema } from './db/bootstrap';
import { observeStartupTaskRetryScheduled, observeStartupTaskRetrySuccess } from './metrics/prometheus';
import { closeRedisClient } from './infra/redis';

export const app = new Telegraf<BotContext>(config.bot.token);

app.catch((error, ctx) => {
  logger.error({ err: error, update: ctx.update }, 'Unhandled error in Telegraf');
});

app.use(errorBoundary());
app.use(session());
app.use(metricsCollector());
app.use(antiFlood());
app.use(autoDelete());
app.use(auth());
app.use(savePhone);
app.use(ensurePhone);
app.use(keyboardGuard());
app.use(stateGate());
app.use(callbackDecoder());
app.use(ensureVerifiedExecutor);

registerStartCommand(app);
registerBindCommand(app);
registerCityCommand(app);
registerHelpCommand(app);
registerSafeModeActions(app);
registerClientMenu(app);
registerClientOrdersFlow(app);
registerTaxiOrderFlow(app);
registerDeliveryOrderFlow(app);
registerClientSupport(app);
registerClientFallback(app);
registerExecutorRoleSelect(app);
registerExecutorVerification(app);
registerExecutorSubscription(app);
registerExecutorOrders(app);
registerExecutorMenu(app);
registerExecutorSupport(app);
registerVerificationModerationQueue(app);
registerPaymentModerationQueue(app);
registerSupportModerationBridge(app);
registerOrdersChannel(app);
registerChannelCommands(app);
registerJoinRequests(app);
registerMembershipSync(app);

app.hears(PHONE_HELP_BUTTON_LABEL, respondToPhoneHelp);
app.hears(PHONE_STATUS_BUTTON_LABEL, respondToPhoneStatus);

app.on('message', unknownHandler);

let gracefulShutdownConfigured = false;
let cleanupStarted = false;
let databaseConnectionFallback = false;

const RETRY_INTERVAL_MS = 10_000;
const retryTimers = new Map<string, NodeJS.Timeout>();
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
const POSTGRES_CONNECTION_CODE_PREFIXES = ['57P', '08'];
const CONNECTION_ERROR_PATTERNS = [
  /connect(?:ion)? (?:was )?refused/i,
  /connect(?:ion)? (?:failed|terminated|closed)/i,
  /terminating connection/i,
  /server closed the connection unexpectedly/i,
];

type CleanupTask = () => Promise<void> | void;

type StartupTask = {
  name: string;
  label: string;
  handler: () => Promise<void>;
};

const cleanupTasks: CleanupTask[] = [];

export const registerCleanupTask = (task: CleanupTask): void => {
  cleanupTasks.push(task);
};

registerCleanupTask(closeRedisClient);

const stopRetryTimer = (name: string): void => {
  const timer = retryTimers.get(name);
  if (timer) {
    clearInterval(timer);
    retryTimers.delete(name);
  }
};

const extractErrorMessage = (error: unknown): string | undefined => {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  return undefined;
};

const isConnectionError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    const message = extractErrorMessage(error);
    return message ? CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message)) : false;
  }

  const candidate = error as { code?: unknown };
  const code = candidate.code;

  if (typeof code === 'string') {
    if (CONNECTION_ERROR_CODES.has(code)) {
      return true;
    }

    if (POSTGRES_CONNECTION_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
      return true;
    }
  }

  const message = extractErrorMessage(error);
  if (!message) {
    return false;
  }

  return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};

const scheduleRetry = (
  name: string,
  task: () => Promise<void>,
  onSuccess?: () => void,
  onFailure?: (error: unknown) => void,
): void => {
  if (retryTimers.has(name)) {
    return;
  }

  let running = false;

  const invoke = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await task();
      stopRetryTimer(name);
      onSuccess?.();
    } catch (error) {
      onFailure?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void invoke();
  }, RETRY_INTERVAL_MS);

  retryTimers.set(name, timer);
  registerCleanupTask(() => {
    stopRetryTimer(name);
  });
};

const runStartupTaskWithRetry = async ({ name, label, handler }: StartupTask): Promise<void> => {
  try {
    await handler();
    stopRetryTimer(name);
  } catch (error) {
    if (!isConnectionError(error)) {
      logger.error({ err: error }, `Failed to restore ${label}`);
      return;
    }

    logger.warn(
      { err: error },
      `Failed to restore ${label} due to connection error, scheduling retry`,
    );
    observeStartupTaskRetryScheduled(name);

    scheduleRetry(
      name,
      handler,
      () => {
        observeStartupTaskRetrySuccess(name);
        logger.info(`Successfully restored ${label} after retry`);
      },
      (retryError) => {
        if (isConnectionError(retryError)) {
          logger.warn(
            { err: retryError },
            `Retry to restore ${label} failed due to connection error, will continue retrying`,
          );
        } else {
          logger.error(
            { err: retryError },
            `Retry to restore ${label} failed with unexpected error`,
          );
        }
      },
    );
  }
};

export const isDatabaseFallbackActive = (): boolean => databaseConnectionFallback;

export const isShutdownInProgress = (): boolean => cleanupStarted;

const botAlreadyStoppedPatterns = [
  /bot is not running/i,
  /bot has not been started/i,
  /stop\s+.*before\s+start/i,
];

const isBotAlreadyStoppedError = (error: unknown): error is Error => {
  if (!(error instanceof Error)) {
    return false;
  }

  return botAlreadyStoppedPatterns.some((pattern) => pattern.test(error.message));
};

export const setupGracefulShutdown = (bot: Telegraf<BotContext>): void => {
  if (gracefulShutdownConfigured) {
    return;
  }
  gracefulShutdownConfigured = true;

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, () => {
      if (cleanupStarted) {
        return;
      }
      cleanupStarted = true;

      logger.info({ signal }, 'Received shutdown signal, stopping bot');
      const cleanup = async (): Promise<void> => {
        try {
          try {
            bot.stop(`Received ${signal}`);
          } catch (error) {
            if (isBotAlreadyStoppedError(error)) {
              logger.info({ err: error }, 'Bot already stopped before cleanup, continuing shutdown');
            } else {
              throw error;
            }
          }

          for (const task of cleanupTasks) {
            await Promise.resolve()
              .then(() => task())
              .catch((error) => {
                logger.error({ err: error }, 'Cleanup task failed');
                throw error;
              });
          }

          await pool.end();
          logger.info('Shutdown cleanup completed, exiting process');
          process.exit(0);
        } catch (error) {
          logger.error({ err: error }, 'Failed to shutdown gracefully');
          process.exitCode = 1;
          process.exit(1);
        }
      };

      void cleanup();
    });
  }
};

setupGracefulShutdown(app);

export const initialiseAppState = async (): Promise<void> => {
  try {
    await ensureDatabaseSchema();
    databaseConnectionFallback = false;
    stopRetryTimer('ensureDatabaseSchema');
  } catch (error) {
    if (!isConnectionError(error)) {
      throw error;
    }

    databaseConnectionFallback = true;
    logger.warn({ err: error }, 'Database schema check failed due to connection error, scheduling retry');
    scheduleRetry(
      'ensureDatabaseSchema',
      ensureDatabaseSchema,
      () => {
        databaseConnectionFallback = false;
        logger.info('Database schema check succeeded after retry, disabling fallback mode');
      },
      (retryError) => {
        if (isConnectionError(retryError)) {
          logger.warn(
            { err: retryError },
            'Database schema retry failed due to connection error, will continue retrying',
          );
        } else {
          logger.error({ err: retryError }, 'Database schema retry failed with unexpected error');
        }
      },
    );
  }

  const startupTasks: StartupTask[] = [
    {
      name: 'restoreVerificationModerationQueue',
      label: 'verification moderation queue',
      handler: restoreVerificationModerationQueue,
    },
    {
      name: 'restorePaymentModerationQueue',
      label: 'payment moderation queue',
      handler: restorePaymentModerationQueue,
    },
    {
      name: 'restoreSupportThreads',
      label: 'support threads',
      handler: restoreSupportThreads,
    },
  ];

  await Promise.all(startupTasks.map((task) => runStartupTaskWithRetry(task)));
};

/**
 * Testing helper used to reset retry state between test cases.
 */
export const resetStartupRetryStateForTests = (): void => {
  for (const name of [...retryTimers.keys()]) {
    stopRetryTimer(name);
  }
  databaseConnectionFallback = false;
};
