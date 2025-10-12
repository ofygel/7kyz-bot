import process from 'node:process';
import { Telegraf } from 'telegraf';

import { config } from '../config';
import { pool } from '../db';
import { closeRedisClient, getRedisClient } from '../infra/redis';
import { buildWebhookConfig } from '../utils/webhook';

type CheckStatus = 'ok' | 'warn' | 'error';

interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string;
}

interface CheckSuccessResult {
  status?: Extract<CheckStatus, 'ok' | 'warn'>;
  message: string;
}

type CheckHandler = () => Promise<string | CheckSuccessResult>;

const results: CheckResult[] = [];

const normaliseSuccess = (value: string | CheckSuccessResult): CheckSuccessResult =>
  typeof value === 'string' ? { status: 'ok', message: value } : value;

const normaliseError = (error: unknown): { message: string; details?: string } => {
  if (error instanceof Error) {
    return {
      message: `${error.name}: ${error.message}`,
      details: error.stack,
    };
  }

  return {
    message: typeof error === 'string' ? error : JSON.stringify(error),
  };
};

const runCheck = async (name: string, handler: CheckHandler): Promise<void> => {
  try {
    const { status = 'ok', message } = normaliseSuccess(await handler());
    results.push({ name, status, message });
  } catch (error) {
    const { message, details } = normaliseError(error);
    results.push({ name, status: 'error', message, details });
  }
};

const formatTimestamp = (value: number | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
};

const run = async (): Promise<void> => {
  await runCheck('Database connection', async () => {
    const { rows } = await pool.query<{ now: Date }>('SELECT now() AS now');
    const serverTime = rows[0]?.now instanceof Date ? rows[0].now.toISOString() : String(rows[0]?.now);
    return `Connected (server time: ${serverTime ?? 'unknown'})`;
  });

  await runCheck('Redis connection', async () => {
    const redis = getRedisClient();
    if (!redis) {
      return { status: 'warn', message: 'Redis is not configured; session cache and queues are disabled.' };
    }

    try {
      await redis.connect();
      const response = await redis.ping();
      return `Ping response: ${response}`;
    } finally {
      await closeRedisClient();
    }
  });

  const telegramClient = new Telegraf(config.bot.token, { handlerTimeout: 10_000 });
  const telegram = telegramClient.telegram;

  await runCheck('Telegram bot token', async () => {
    const me = await telegram.getMe();
    const username = me.username ? `@${me.username}` : me.first_name ?? 'unknown';
    return `Authenticated as ${username} (id: ${me.id})`;
  });

  await runCheck('Telegram webhook', async () => {
    const info = await telegram.getWebhookInfo();
    const { url } = buildWebhookConfig(config.webhook.domain, config.webhook.secret);

    const expectedUrl = url;
    const registeredUrl = info.url || '(not set)';

    if (!info.url) {
      throw new Error(`No webhook registered. Expected ${expectedUrl}`);
    }

    if (info.url !== expectedUrl) {
      throw new Error(`Webhook mismatch. Expected ${expectedUrl}, got ${registeredUrl}`);
    }

    const extraNotes: string[] = [];
    if (info.pending_update_count > 0) {
      extraNotes.push(`pending updates: ${info.pending_update_count}`);
    }

    const lastError = formatTimestamp(info.last_error_date);
    if (lastError && info.last_error_message) {
      extraNotes.push(`last error at ${lastError}: ${info.last_error_message}`);
    } else if (lastError) {
      extraNotes.push(`last error at ${lastError}`);
    }

    const lastSyncError = formatTimestamp(info.last_synchronization_error_date);
    if (lastSyncError) {
      extraNotes.push(`last sync error at ${lastSyncError}`);
    }

    const message = extraNotes.length > 0
      ? `Webhook is registered correctly (${registeredUrl}); ${extraNotes.join('; ')}`
      : `Webhook is registered correctly (${registeredUrl})`;

    const status: CheckStatus = info.pending_update_count > 0 || lastError || lastSyncError ? 'warn' : 'ok';

    return { status, message };
  });

  await runCheck('Telegram getUpdates backlog', async () => {
    try {
      const updates = await telegram.getUpdates(0, 1, 0, undefined);
      if (updates.length > 0) {
        return {
          status: 'warn',
          message: `There are ${updates.length} updates waiting in long polling queue. Webhook may be disabled.`,
        };
      }

      return 'No pending updates in long polling queue';
    } catch (error) {
      const candidate = error as {
        code?: unknown;
        response?: { error_code?: unknown; description?: unknown };
        description?: unknown;
      };

      const errorCode =
        typeof candidate?.code === 'number'
          ? candidate.code
          : typeof candidate?.response?.error_code === 'number'
            ? candidate.response.error_code
            : undefined;

      if (errorCode === 409) {
        return {
          status: 'ok',
          message: 'Webhook mode is active (getUpdates is unavailable by design).',
        };
      }

      throw error;
    }
  });

  await telegramClient.stop();

  try {
    await pool.end();
  } catch (error) {
    const { message } = normaliseError(error);
    results.push({ name: 'Database pool shutdown', status: 'warn', message });
  }

  const hasErrors = results.some((result) => result.status === 'error');

  for (const result of results) {
    const prefix =
      result.status === 'ok'
        ? '✅'
        : result.status === 'warn'
          ? '⚠️'
          : '❌';
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${result.name}: ${result.message}`);
    if (result.details) {
      // eslint-disable-next-line no-console
      console.log(result.details);
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  const { message, details } = normaliseError(error);
  // eslint-disable-next-line no-console
  console.error(`❌ Audit failed: ${message}`);
  if (details) {
    // eslint-disable-next-line no-console
    console.error(details);
  }
  process.exit(1);
});

