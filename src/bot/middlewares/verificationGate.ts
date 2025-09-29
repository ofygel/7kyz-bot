import { type MiddlewareFn } from 'telegraf';

import { logger } from '../../config';
import { isExecutorVerified } from '../../db/verifications';
import { CITY_ACTION_PATTERN } from '../flows/common/citySelect';
import {
  EXECUTOR_MENU_ACTION,
  EXECUTOR_MENU_CITY_ACTION,
  EXECUTOR_ORDERS_ACTION,
  EXECUTOR_SUBSCRIPTION_ACTION,
  EXECUTOR_SUPPORT_ACTION,
  EXECUTOR_VERIFICATION_ACTION,
  ensureExecutorState,
  isExecutorMenuTextCommand,
} from '../flows/executor/menu';
import {
  EXECUTOR_ROLE_SWITCH_ACTION,
  EXECUTOR_VERIFICATION_GUIDE_ACTION,
  VERIFICATION_PROMPT_STEP_ID,
  showExecutorVerificationPrompt,
  startExecutorVerification,
} from '../flows/executor/verification';
import { EXECUTOR_ROLES, type BotContext, type ExecutorRole } from '../types';

const COLLECTING_SAFE_COMMANDS = new Set(['/start', '/menu', '/help']);
const COLLECTING_SAFE_CALLBACK_PREFIXES = ['role:'];
const COLLECTING_SAFE_CALLBACKS = new Set([
  EXECUTOR_MENU_ACTION,
  EXECUTOR_MENU_CITY_ACTION,
  EXECUTOR_ORDERS_ACTION,
  EXECUTOR_SUBSCRIPTION_ACTION,
  EXECUTOR_SUPPORT_ACTION,
  EXECUTOR_VERIFICATION_ACTION,
  EXECUTOR_ROLE_SWITCH_ACTION,
  EXECUTOR_VERIFICATION_GUIDE_ACTION,
]);
const VERIFICATION_REMINDER_INTERVAL_MS = 60_000;

const isExecutorKind = (value: unknown): value is ExecutorRole =>
  typeof value === 'string' && EXECUTOR_ROLES.includes(value as ExecutorRole);

const resolveExecutorRole = (ctx: BotContext, fallback: ExecutorRole): ExecutorRole => {
  const sessionRole = ctx.session.executor?.role;
  if (isExecutorKind(sessionRole)) {
    return sessionRole;
  }

  return fallback;
};

export const ensureVerifiedExecutor: MiddlewareFn<BotContext> = async (ctx, next) => {
  const role = ctx.auth?.user.role;
  if (role !== 'executor' && role !== 'moderator') {
    await next();
    return;
  }

  const executorKind = ctx.auth?.user.executorKind;
  if (!isExecutorKind(executorKind)) {
    await next();
    return;
  }

  const telegramId = ctx.auth?.user.telegramId ?? ctx.from?.id;
  if (!telegramId) {
    await next();
    return;
  }

  const executorRole = resolveExecutorRole(ctx, executorKind);

  try {
    const verified = await isExecutorVerified(telegramId, executorRole);
    if (verified) {
      await next();
      return;
    }
  } catch (error) {
    logger.error(
      { err: error, telegramId, executorRole },
      'Failed to check executor verification status',
    );
    await next();
    return;
  }

  const state = ensureExecutorState(ctx);
  const verificationState = state.verification[executorRole];

  const callbackQuery = ctx.callbackQuery;
  if (callbackQuery && 'data' in callbackQuery) {
    const callbackData = callbackQuery.data;
    if (
      typeof callbackData === 'string' &&
      (callbackData.startsWith('mod:') || CITY_ACTION_PATTERN.test(callbackData))
    ) {
      await next();
      return;
    }
  }

  const message = ctx.message;
  const hasPhoto =
    message && 'photo' in message && Array.isArray(message.photo) && message.photo.length > 0;
  const messageText = message && 'text' in message ? message.text : undefined;

  const isSafeCollectingCallback =
    callbackQuery &&
    'data' in callbackQuery &&
    typeof callbackQuery.data === 'string' &&
    (COLLECTING_SAFE_CALLBACK_PREFIXES.some((prefix) => callbackQuery.data.startsWith(prefix)) ||
      COLLECTING_SAFE_CALLBACKS.has(callbackQuery.data));

  const isSafeCollectingCommand =
    typeof messageText === 'string' &&
    (COLLECTING_SAFE_COMMANDS.has(messageText) || isExecutorMenuTextCommand(messageText));

  if (verificationState.status === 'collecting' && hasPhoto) {
    await next();
    return;
  }

  if (
    verificationState.status === 'collecting' &&
    (isSafeCollectingCommand || isSafeCollectingCallback)
  ) {
    await next();
    return;
  }

  if (verificationState.status === 'collecting') {
    const now = Date.now();
    const lastReminderAt = verificationState.lastReminderAt ?? 0;
    const shouldSendReminder = now - lastReminderAt >= VERIFICATION_REMINDER_INTERVAL_MS;
    const promptStep = ctx.session.ui?.steps?.[VERIFICATION_PROMPT_STEP_ID];
    const hasPromptStep = Boolean(promptStep && promptStep.chatId === ctx.chat?.id);
    const isUnsupportedInput = !hasPhoto && !isSafeCollectingCommand && !isSafeCollectingCallback;
    const needsPrompt = isUnsupportedInput || shouldSendReminder || !hasPromptStep;

    if (needsPrompt) {
      try {
        const promptResult = await showExecutorVerificationPrompt(ctx, executorRole);
        if (promptResult !== undefined) {
          verificationState.lastReminderAt = now;
        }
      } catch (error) {
        logger.debug({ err: error }, 'Failed to send verification reminder');
      }
    }

    if (isUnsupportedInput) {
      return;
    }

    return;
  }

  await startExecutorVerification(ctx);
};
