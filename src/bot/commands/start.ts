import { Telegraf } from 'telegraf';

import type { BotContext } from '../types';
import { setChatCommands } from '../services/commands';
import { CLIENT_COMMANDS, EXECUTOR_COMMANDS } from './sets';
import { hideClientMenu, sendClientMenu } from '../../ui/clientMenu';
import { logger } from '../../config';
import { askPhone, buildPhoneCollectKeyboard, PHONE_HELP_BUTTON_LABEL } from '../flows/common/phoneCollect';
import { ensureExecutorState, showExecutorMenu } from '../flows/executor/menu';
import { startExecutorVerification } from '../flows/executor/verification';
import { startExecutorSubscription } from '../flows/executor/subscription';
import { buildInlineKeyboard } from '../keyboards/common';
import { ui } from '../ui';
import { clearOnboardingState, setOnboardingStep } from '../services/onboarding';
import {
  ROLE_SELECTION_BACK_ACTION,
  ROLE_PICK_CLIENT_ACTION,
  ROLE_PICK_HELP_ACTION,
  ROLE_PICK_EXECUTOR_ACTION,
  EXECUTOR_KIND_BACK_ACTION,
  EXECUTOR_KIND_COURIER_ACTION,
  EXECUTOR_KIND_DRIVER_ACTION,
  EXECUTOR_ROLE_PENDING_CITY_ACTION,
} from '../flows/executor/roleSelectionConstants';

const ROLE_PICK_STEP_ID = 'start:role:pick';
const EXECUTOR_KIND_STEP_ID = 'start:role:executor-kind';
const ROLE_PICK_TITLE = 'Выбор роли';
const ROLE_PICK_DESCRIPTION =
  'Бот помогает клиентам оформлять заказы и исполнителям брать их в работу. Выберите подходящую роль.';
const ROLE_PICK_HINT =
  'ℹ️ Подсказка: выберите «Клиент», если хотите оформлять заказы. Нажмите «Исполнитель», чтобы брать заказы в работу.';

const EXECUTOR_KIND_TITLE = 'Выбор специализации';
const EXECUTOR_KIND_DESCRIPTION =
  'Уточните, какие заказы хотите получать: доставка подходит курьерам, поездки — водителям.';
const EXECUTOR_KIND_HINT = 'ℹ️ Курьеры занимаются доставкой, водители помогают с поездками.';

const START_WELCOME_STEP_ID = 'start:welcome';
const START_WELCOME_TITLE = 'Добро пожаловать в Freedom Bot';
const START_WELCOME_TEXT = [
  'Freedom Bot помогает оформить заказ и подключиться к исполнителям.',
  'Чтобы начать, поделитесь контактом — Telegram отправит номер автоматически. Если нужна подсказка, нажмите «Помощь».',
].join('\n\n');
const START_WELCOME_ACTIONS = ['📲 Поделиться контактом', PHONE_HELP_BUTTON_LABEL];

const buildStartWelcomeText = (): string => [START_WELCOME_TITLE, '', START_WELCOME_TEXT].join('\n');

const buildStartWelcomePayload = () => ({
  step: {
    id: START_WELCOME_STEP_ID,
    title: START_WELCOME_TITLE,
    text: START_WELCOME_TEXT,
    actions: START_WELCOME_ACTIONS,
  },
});

const buildRolePickKeyboard = () =>
  buildInlineKeyboard([
    [
      { label: 'Клиент', action: ROLE_PICK_CLIENT_ACTION },
      { label: 'Исполнитель', action: ROLE_PICK_EXECUTOR_ACTION },
    ],
    [{ label: 'Помощь', action: ROLE_PICK_HELP_ACTION }],
  ]);

const buildExecutorKindKeyboard = () =>
  buildInlineKeyboard([
    [
      { label: 'Курьер', action: EXECUTOR_KIND_COURIER_ACTION },
      { label: 'Водитель', action: EXECUTOR_KIND_DRIVER_ACTION },
    ],
    [{ label: 'Назад', action: EXECUTOR_KIND_BACK_ACTION }],
  ]);

const resetCitySelectionTracking = (ctx: BotContext): void => {
  if (ctx.session.ui?.pendingCityAction === EXECUTOR_ROLE_PENDING_CITY_ACTION) {
    ctx.session.ui.pendingCityAction = undefined;
  }
};

const buildRolePickText = (options?: { withHint?: boolean }): string => {
  const withHint = options?.withHint ?? false;
  const lines = [ROLE_PICK_TITLE, '', ROLE_PICK_DESCRIPTION];
  if (withHint) {
    lines.push('', ROLE_PICK_HINT);
  }
  return lines.join('\n');
};

const buildExecutorKindText = (options?: { withHint?: boolean }): string => {
  const withHint = options?.withHint ?? true;
  const lines = [EXECUTOR_KIND_TITLE, '', EXECUTOR_KIND_DESCRIPTION];
  if (withHint) {
    lines.push('', EXECUTOR_KIND_HINT);
  }
  return lines.join('\n');
};

export const presentRolePick = async (
  ctx: BotContext,
  options?: { withHint?: boolean },
): Promise<void> => {
  const withHint = options?.withHint ?? false;
  const executorState = ensureExecutorState(ctx);
  executorState.awaitingRoleSelection = true;
  executorState.role = undefined;
  executorState.roleSelectionStage = 'role';
  ctx.auth.user.executorKind = undefined;
  resetCitySelectionTracking(ctx);

  await ui.step(ctx, {
    id: ROLE_PICK_STEP_ID,
    text: buildRolePickText({ withHint }),
    keyboard: buildRolePickKeyboard(),
  });
  setOnboardingStep(ctx, 'role');
};

export const presentExecutorKindSelection = async (
  ctx: BotContext,
  options?: { withHint?: boolean },
): Promise<void> => {
  const withHint = options?.withHint ?? true;
  const executorState = ensureExecutorState(ctx);
  executorState.awaitingRoleSelection = true;
  executorState.role = undefined;
  executorState.roleSelectionStage = 'executorKind';
  ctx.auth.user.executorKind = undefined;
  resetCitySelectionTracking(ctx);

  await ui.step(ctx, {
    id: EXECUTOR_KIND_STEP_ID,
    text: buildExecutorKindText({ withHint }),
    keyboard: buildExecutorKindKeyboard(),
  });
  setOnboardingStep(ctx, 'executorKind');
};

const applyCommandsForRole = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const role = ctx.auth?.user.role;
  if (role === 'client') {
    await setChatCommands(ctx.telegram, ctx.chat.id, CLIENT_COMMANDS, { showMenuButton: true });
    return;
  }

  if (role === 'executor' || role === 'moderator') {
    await setChatCommands(ctx.telegram, ctx.chat.id, EXECUTOR_COMMANDS, { showMenuButton: true });
  }
};

export const handleStart = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Пожалуйста, начните диалог с ботом в личных сообщениях.');
    return;
  }

  if (!ctx.session.user?.phoneVerified) {
    try {
      await ui.step(ctx, {
        id: START_WELCOME_STEP_ID,
        text: buildStartWelcomeText(),
        keyboard: buildPhoneCollectKeyboard(),
        payload: buildStartWelcomePayload(),
      });
    } catch (error) {
      logger.debug({ err: error, chatId: ctx.chat?.id }, 'Failed to render start welcome step');
    }
    await askPhone(ctx);
    return;
  }

  await applyCommandsForRole(ctx);
  const userRole = ctx.auth.user.role;
  if (userRole === 'client') {
    clearOnboardingState(ctx);
    await hideClientMenu(ctx, 'Открываю главное меню…');
    await sendClientMenu(ctx, 'Чем займёмся дальше? Выберите действие из меню ниже.');
    return;
  }

  const executorState = ensureExecutorState(ctx);
  const role = executorState.role;
  const stage = executorState.roleSelectionStage;
  const awaitingRoleSelection = executorState.awaitingRoleSelection === true;
  const needsRoleSelection =
    !role || awaitingRoleSelection || stage === 'role' || stage === 'executorKind' || stage === 'city';
  if (needsRoleSelection) {
    executorState.awaitingRoleSelection = true;
    executorState.role = undefined;
    const prompt = stage === 'executorKind' || stage === 'city'
      ? 'Выберите специализацию исполнителя ниже.'
      : 'Меняем роль — выберите подходящий вариант ниже.';
    const showRoleHint = stage === 'role';
    const showExecutorKindHint = stage === 'executorKind' || stage === 'city';
    await hideClientMenu(ctx, prompt);
    if (stage === 'executorKind' || stage === 'city') {
      await presentExecutorKindSelection(ctx, { withHint: showExecutorKindHint });
    } else {
      await presentRolePick(ctx, { withHint: showRoleHint });
    }
    return;
  }

  clearOnboardingState(ctx);

  const verification = executorState.verification[role];
  if (verification.status === 'idle' || verification.status === 'collecting') {
    await startExecutorVerification(ctx);
    return;
  }

  const subscriptionStatus = executorState.subscription.status;
  if (subscriptionStatus === 'awaitingReceipt' || subscriptionStatus === 'pendingModeration') {
    await startExecutorSubscription(ctx, { skipVerificationCheck: true });
    return;
  }

  clearOnboardingState(ctx);
  await showExecutorMenu(ctx);
};

export const registerStartCommand = (bot: Telegraf<BotContext>): void => {
  bot.start(handleStart);
  bot.hears(/^start$/i, handleStart);

  bot.action(ROLE_PICK_EXECUTOR_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      try {
        await ctx.answerCbQuery('Пожалуйста, продолжите в личном чате с ботом.');
      } catch {
        // Ignore
      }
      return;
    }

    const executorState = ensureExecutorState(ctx);
    executorState.awaitingRoleSelection = true;
    executorState.role = undefined;
    executorState.roleSelectionStage = 'executorKind';
    ctx.auth.user.executorKind = undefined;
    resetCitySelectionTracking(ctx);
    setOnboardingStep(ctx, 'executorKind');

    try {
      await ctx.answerCbQuery('Теперь выберите специализацию.');
    } catch {
      // Ignore callback errors
    }

    await presentExecutorKindSelection(ctx);
  });

  bot.action(ROLE_PICK_HELP_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      try {
        await ctx.answerCbQuery('Подсказки доступны только в личном чате с ботом.');
      } catch {
        // Ignore
      }
      return;
    }

    const executorState = ensureExecutorState(ctx);
    executorState.awaitingRoleSelection = true;
    executorState.role = undefined;
    executorState.roleSelectionStage = 'role';
    ctx.auth.user.executorKind = undefined;
    resetCitySelectionTracking(ctx);
    setOnboardingStep(ctx, 'role');

    try {
      await ctx.answerCbQuery('Подсказка отправлена.');
    } catch {
      // Ignore callback errors
    }

    await presentRolePick(ctx, { withHint: true });
  });

  bot.action(EXECUTOR_KIND_BACK_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      try {
        await ctx.answerCbQuery('Доступно только в личном чате с ботом.');
      } catch {
        // Ignore
      }
      return;
    }

    const executorState = ensureExecutorState(ctx);
    executorState.awaitingRoleSelection = true;
    executorState.role = undefined;
    executorState.roleSelectionStage = 'role';
    ctx.auth.user.executorKind = undefined;
    resetCitySelectionTracking(ctx);
    setOnboardingStep(ctx, 'role');

    try {
      await ctx.answerCbQuery('Вернёмся к выбору роли.');
    } catch {
      // Ignore callback errors
    }

    await presentRolePick(ctx, { withHint: true });
  });

  bot.action(ROLE_SELECTION_BACK_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      try {
        await ctx.answerCbQuery('Доступно только в личном чате с ботом.');
      } catch {
        // Ignore
      }
      return;
    }

    const executorState = ensureExecutorState(ctx);
    const stage = executorState.roleSelectionStage;

    const goToRoleSelection = async (message: string, options?: { withHint?: boolean }) => {
      executorState.awaitingRoleSelection = true;
      executorState.role = undefined;
      executorState.roleSelectionStage = 'role';
      ctx.auth.user.executorKind = undefined;
      resetCitySelectionTracking(ctx);

      try {
        await ctx.answerCbQuery(message);
      } catch {
        // Ignore callback errors
      }

      await presentRolePick(ctx, options);
    };

    if (stage === 'city') {
      executorState.awaitingRoleSelection = true;
      executorState.role = undefined;
      executorState.roleSelectionStage = 'executorKind';
      ctx.auth.user.executorKind = undefined;
      resetCitySelectionTracking(ctx);
      setOnboardingStep(ctx, 'executorKind');

      try {
        await ctx.answerCbQuery('Вернёмся к выбору специализации.');
      } catch {
        // Ignore callback errors
      }

      await presentExecutorKindSelection(ctx, { withHint: true });
      return;
    }

    if (stage === 'executorKind') {
      setOnboardingStep(ctx, 'role');
      await goToRoleSelection('Вернёмся к выбору роли.', { withHint: true });
      return;
    }

    setOnboardingStep(ctx, 'role');
    await goToRoleSelection('Вы на шаге выбора роли.');
  });

  bot.on('contact', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await next();
      return;
    }

    const phoneJustVerified = Boolean(
      (ctx.state as { phoneJustVerified?: unknown }).phoneJustVerified,
    );
    if (!phoneJustVerified) {
      await next();
      return;
    }

    await applyCommandsForRole(ctx);
    const executorState = ensureExecutorState(ctx);
    executorState.awaitingRoleSelection = true;
    executorState.role = undefined;
    await presentRolePick(ctx);
  });
};

