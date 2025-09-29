import { logger } from '../../config';
import { pool } from '../../db';
import { loadFlowMeta } from '../../db/sessions';
import type { BotContext } from '../types';
import { resolveSessionKey } from '../middlewares/session';

interface RecoveryPayloadShape {
  type?: string;
  payload?: unknown;
}

type RecoveryHandler = (ctx: BotContext, payload: unknown) => Promise<boolean> | boolean;

const handlers = new Map<string, RecoveryHandler>();

export const registerFlowRecovery = (type: string, handler: RecoveryHandler): void => {
  handlers.set(type, handler);
};

export const resumeLastFlowStep = async (ctx: BotContext): Promise<boolean> => {
  const key = resolveSessionKey(ctx);
  if (!key) {
    return false;
  }

  const meta = await loadFlowMeta(pool, key);
  if (!meta) {
    return false;
  }

  const payloadObject =
    meta.payload && typeof meta.payload === 'object'
      ? (meta.payload as { recovery?: RecoveryPayloadShape })
      : null;
  const recovery = payloadObject?.recovery;
  if (!recovery || typeof recovery.type !== 'string' || recovery.type.length === 0) {
    return false;
  }

  const handler = handlers.get(recovery.type);
  if (!handler) {
    logger.warn({ recoveryType: recovery.type }, 'Missing recovery handler for flow step');
    return false;
  }

  try {
    const result = await handler(ctx, recovery.payload);
    return Boolean(result);
  } catch (error) {
    logger.error({ err: error, recoveryType: recovery.type }, 'Failed to resume flow step');
    return false;
  }
};
