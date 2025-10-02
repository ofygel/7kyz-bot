import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { config } from '../../config';
import type { ExecutorPlanRecord } from '../../types';
import {
  EXECUTOR_PLAN_BLOCK_ACTION,
  EXECUTOR_PLAN_EDIT_ACTION,
  EXECUTOR_PLAN_EXTEND_ACTION,
  EXECUTOR_PLAN_TOGGLE_MUTE_ACTION,
  EXECUTOR_PLAN_UNBLOCK_ACTION,
} from '../../services/executorPlans/actions';
import { wrapCallbackData } from '../services/callbackTokens';

const CALLBACK_TTL_SECONDS = 7 * 24 * 60 * 60;

const buildExtendAction = async (planId: number, days: number, secret: string): Promise<string> =>
  wrapCallbackData(`${EXECUTOR_PLAN_EXTEND_ACTION}:${planId}:${days}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });

export const buildExecutorPlanActionKeyboard = async (
  plan: ExecutorPlanRecord,
): Promise<InlineKeyboardMarkup> => {
  const secret = config.bot.hmacSecret;

  const extend7 = await buildExtendAction(plan.id, 7, secret);
  const extend15 = await buildExtendAction(plan.id, 15, secret);
  const extend30 = await buildExtendAction(plan.id, 30, secret);

  const blockAction = await wrapCallbackData(`${EXECUTOR_PLAN_BLOCK_ACTION}:${plan.id}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });
  const unblockAction = await wrapCallbackData(`${EXECUTOR_PLAN_UNBLOCK_ACTION}:${plan.id}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });
  const toggleMuteAction = await wrapCallbackData(`${EXECUTOR_PLAN_TOGGLE_MUTE_ACTION}:${plan.id}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });
  const editAction = await wrapCallbackData(`${EXECUTOR_PLAN_EDIT_ACTION}:${plan.id}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });

  const rows: InlineKeyboardMarkup['inline_keyboard'] = [
    [
      { text: '+7', callback_data: extend7 },
      { text: '+15', callback_data: extend15 },
      { text: '+30', callback_data: extend30 },
    ],
    [
      { text: '⛔', callback_data: blockAction },
      { text: plan.muted ? '🔔' : '🔕', callback_data: toggleMuteAction },
      { text: '✏️', callback_data: editAction },
    ],
  ];

  if (plan.status === 'blocked') {
    rows.push([{ text: '✅ Разблокировать', callback_data: unblockAction }]);
  }

  return { inline_keyboard: rows } satisfies InlineKeyboardMarkup;
};
