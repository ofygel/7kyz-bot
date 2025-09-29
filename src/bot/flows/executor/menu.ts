import { Markup, Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import {
  EXECUTOR_VERIFICATION_PHOTO_COUNT,
  type BotContext,
  type ExecutorFlowState,
  type ExecutorRole,
  type ExecutorVerificationRoleState,
} from '../../types';
import { getExecutorRoleCopy } from '../../copy';
import { ui } from '../../ui';
import { CITY_LABEL } from '../../../domain/cities';
import { CITY_ACTION_PATTERN, ensureCitySelected } from '../common/citySelect';
import { presentRolePick } from '../../commands/start';
import { startExecutorVerification } from './verification';
import { startExecutorSubscription } from './subscription';

export const EXECUTOR_VERIFICATION_ACTION = 'executor:verification:start';
export const EXECUTOR_SUBSCRIPTION_ACTION = 'executor:subscription:link';
export const EXECUTOR_ORDERS_ACTION = 'executor:orders:link';
export const EXECUTOR_SUPPORT_ACTION = 'support:contact';
export const EXECUTOR_MENU_ACTION = 'executor:menu:refresh';
export const EXECUTOR_MENU_CITY_ACTION = 'executorMenu';

export const EXECUTOR_MENU_TEXT_LABELS = {
  documents: '📸 Документы',
  subscription: '📨 Подписка/Ссылка',
  orders: '🧾 Заказы',
  support: '🆘 Поддержка',
  refresh: '🔄 Меню',
} as const;

export const EXECUTOR_MENU_TEXT_COMMANDS = Object.values(
  EXECUTOR_MENU_TEXT_LABELS,
) as readonly string[];

export const isExecutorMenuTextCommand = (value: string): boolean =>
  EXECUTOR_MENU_TEXT_COMMANDS.includes(value);

const createRoleVerificationState = (): ExecutorVerificationRoleState => ({
  status: 'idle' as const,
  requiredPhotos: EXECUTOR_VERIFICATION_PHOTO_COUNT,
  uploadedPhotos: [] as ExecutorVerificationRoleState['uploadedPhotos'],
  submittedAt: undefined,
  moderation: undefined,
  lastReminderAt: undefined,
  processedMediaGroups: {},
});

const createVerificationState = (): ExecutorFlowState['verification'] => ({
  courier: createRoleVerificationState(),
  driver: createRoleVerificationState(),
});

const createSubscriptionState = (): ExecutorFlowState['subscription'] => ({
  status: 'idle',
  selectedPeriodId: undefined,
  pendingPaymentId: undefined,
  moderationChatId: undefined,
  moderationMessageId: undefined,
  lastInviteLink: undefined,
  lastIssuedAt: undefined,
  lastReminderAt: undefined,
});

const createExecutorState = (): ExecutorFlowState => ({
  role: undefined,
  verification: createVerificationState(),
  subscription: createSubscriptionState(),
  jobs: { stage: 'idle' },
  awaitingRoleSelection: true,
  roleSelectionStage: 'role',
});

const isExecutorRole = (value: unknown): value is ExecutorRole =>
  typeof value === 'string' && (value === 'courier' || value === 'driver');

const deriveExecutorRole = (ctx: BotContext): ExecutorRole | undefined => {
  const authRole = ctx.auth.user.executorKind;
  if (isExecutorRole(authRole)) {
    return authRole;
  }

  const sessionRole = ctx.session.executor?.role;
  if (isExecutorRole(sessionRole)) {
    return sessionRole;
  }

  return undefined;
};

export const ensureExecutorState = (ctx: BotContext): ExecutorFlowState => {
  if (!ctx.session.executor) {
    ctx.session.executor = createExecutorState();
  }

  const state = ctx.session.executor;
  const derivedRole = deriveExecutorRole(ctx);

  if (derivedRole && !state.role) {
    state.role = derivedRole;
  }

  if (!isExecutorRole(state.role)) {
    state.role = undefined;
    state.awaitingRoleSelection = true;
    state.roleSelectionStage = state.roleSelectionStage ?? 'role';
  } else {
    state.awaitingRoleSelection = false;
    state.roleSelectionStage = undefined;
  }

  if (!state.verification) {
    state.verification = createVerificationState();
  }

  if (!state.subscription) {
    state.subscription = createSubscriptionState();
  }

  if (!state.jobs) {
    state.jobs = { stage: 'idle' };
  } else if (!state.jobs.stage) {
    state.jobs.stage = 'idle';
  }

  return state;
};

export const requireExecutorRole = (state: ExecutorFlowState): ExecutorRole => {
  if (isExecutorRole(state.role)) {
    return state.role;
  }

  throw new Error('Executor role is not set');
};

const SUPPORT_USERNAME = 'seven_support';
const SUPPORT_LINK = `https://t.me/${SUPPORT_USERNAME}`;

const buildMenuKeyboard = (): InlineKeyboardMarkup =>
  Markup.inlineKeyboard([
    [Markup.button.url('📸 Документы', SUPPORT_LINK)],
    [Markup.button.callback('💳 Подписка', EXECUTOR_SUBSCRIPTION_ACTION)],
    [Markup.button.url('🆘 Поддержка', SUPPORT_LINK)],
    [Markup.button.callback('🔄 Обновить меню', EXECUTOR_MENU_ACTION)],
  ]).reply_markup;

const buildMenuText = (state: ExecutorFlowState, city: string): string => {
  const role = requireExecutorRole(state);
  const copy = getExecutorRoleCopy(role);

  const lines = [
    `${copy.emoji} Меню ${copy.genitive}`,
    `🏙️ Город: ${city}`,
    '',
    `📸 Документы: отправьте фото удостоверения по кнопке ниже — команда проверит их и даст обратную связь в @${SUPPORT_USERNAME}.`,
    '💳 Подписка: выберите план по кнопке ниже — там будут инструкции и ссылка на канал.',
    '',
    `Нужна помощь? Поддержка ответит в @${SUPPORT_USERNAME}.`,
    'Используйте кнопки ниже, чтобы открыть подсказки или обновить информацию.',
  ];

  return lines.join('\n');
};

export interface ShowExecutorMenuOptions {
  promptRoleSelection?: boolean;
}

export const showExecutorMenu = async (
  ctx: BotContext,
  options: ShowExecutorMenuOptions = {},
): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const state = ensureExecutorState(ctx);
  if (!state.role) {
    const shouldPrompt = options.promptRoleSelection ?? true;
    if (shouldPrompt) {
      await presentRolePick(ctx, { withHint: true });
    }
    return;
  }

  ctx.session.ui.pendingCityAction = EXECUTOR_MENU_CITY_ACTION;
  const city = await ensureCitySelected(ctx, 'Выберите город, чтобы продолжить.');
  if (!city) {
    return;
  }

  ctx.session.ui.pendingCityAction = undefined;

  const cityLabel = CITY_LABEL[city];
  const text = buildMenuText(state, cityLabel);
  const keyboard = buildMenuKeyboard();

  await ui.step(ctx, {
    id: 'executor:menu:card:v3',
    text,
    keyboard,
    cleanup: false,
  });
};

export const registerExecutorMenu = (bot: Telegraf<BotContext>): void => {
  bot.action(EXECUTOR_MENU_ACTION, async (ctx) => {
    await ctx.answerCbQuery('Обновляем меню…');
    await showExecutorMenu(ctx);
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.refresh, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await showExecutorMenu(ctx);
  });

  bot.action(CITY_ACTION_PATTERN, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      if (typeof next === 'function') {
        await next();
      }
      return;
    }

    await ctx.answerCbQuery();
    await showExecutorMenu(ctx);
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.documents, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await startExecutorVerification(ctx);
  });

  bot.hears(EXECUTOR_MENU_TEXT_LABELS.subscription, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    await startExecutorSubscription(ctx);
  });
};
