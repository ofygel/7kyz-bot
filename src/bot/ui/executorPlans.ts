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

const buildExtendAction = (planId: number, days: number, secret: string): string =>
  wrapCallbackData(`${EXECUTOR_PLAN_EXTEND_ACTION}:${planId}:${days}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });

export const buildExecutorPlanActionKeyboard = (
  plan: ExecutorPlanRecord,
): InlineKeyboardMarkup => {
  const secret = config.bot.hmacSecret ?? config.bot.token;

  const extend7 = buildExtendAction(plan.id, 7, secret);
  const extend15 = buildExtendAction(plan.id, 15, secret);
  const extend30 = buildExtendAction(plan.id, 30, secret);

  const blockAction = wrapCallbackData(`${EXECUTOR_PLAN_BLOCK_ACTION}:${plan.id}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });
  const unblockAction = wrapCallbackData(`${EXECUTOR_PLAN_UNBLOCK_ACTION}:${plan.id}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });
  const toggleMuteAction = wrapCallbackData(`${EXECUTOR_PLAN_TOGGLE_MUTE_ACTION}:${plan.id}`, {
    secret,
    ttlSeconds: CALLBACK_TTL_SECONDS,
  });
  const editAction = wrapCallbackData(`${EXECUTOR_PLAN_EDIT_ACTION}:${plan.id}`, {
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
