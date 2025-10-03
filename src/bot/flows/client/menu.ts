import { Telegraf } from 'telegraf';

import { logger } from '../../../config';
import { ensureClientRole } from '../../../db/users';
import {
  CLIENT_MENU,
  CLIENT_MENU_ACTION,
  CLIENT_MENU_CITY_SELECT_ACTION,
  CLIENT_MENU_PROFILE_ACTION,
  CLIENT_MENU_REFRESH_ACTION,
  CLIENT_MENU_SUPPORT_ACTION,
  CLIENT_MENU_SWITCH_ROLE_ACTION,
  CLIENT_MENU_TRIGGER,
  buildClientMenuKeyboard,
  clientMenuText,
  hideClientMenu,
  isClientChat,
  sendClientMenu,
} from '../../../ui/clientMenu';
import { CITY_LABEL } from '../../../domain/cities';
import { CLIENT_COMMANDS } from '../../commands/sets';
import { setChatCommands } from '../../services/commands';
import type { BotContext } from '../../types';
import { presentRolePick } from '../../commands/start';
import { ensureExecutorState } from '../executor/menu';
import { reportRoleSet, toUserIdentity } from '../../services/reports';
import { promptClientSupport } from './support';
import { askCity, getCityFromContext, CITY_ACTION_PATTERN } from '../common/citySelect';
import { CLIENT_ORDERS_ACTION } from './orderActions';
import { START_TAXI_ORDER_ACTION } from './taxiOrderFlow';
import { START_DELIVERY_ORDER_ACTION } from './deliveryOrderFlow';
import { copy } from '../../copy';
import { ROLE_PICK_CLIENT_ACTION } from '../executor/roleSelectionConstants';
import { clearOnboardingState } from '../../services/onboarding';
import { renderProfileCard, renderProfileCardFromAction } from '../common/profileCard';

const ROLE_CLIENT_ACTION = 'role:client';
const CLIENT_MENU_CITY_ACTION = 'clientMenu' as const;

const buildClientProfileOptions = () => ({
  backAction: CLIENT_MENU_ACTION,
  homeAction: CLIENT_MENU_ACTION,
  changeCityAction: CLIENT_MENU_CITY_SELECT_ACTION,
  supportAction: CLIENT_MENU_SUPPORT_ACTION,
});
export const logClientMenuClick = async (
  ctx: BotContext,
  target: string,
  extra: Record<string, unknown> = {},
) => {
  const authUser = ctx.auth?.user;

  logger.info(
    {
      event: 'client_menu_click',
      target,
      chatId: ctx.chat?.id,
      userId: authUser?.telegramId ?? ctx.from?.id,
      role: authUser?.role,
      ...extra,
    },
    'client_menu_click',
  );
};

const applyClientCommands = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  await setChatCommands(ctx.telegram, ctx.chat.id, CLIENT_COMMANDS, { showMenuButton: true });
};

const removeRoleSelectionMessage = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  try {
    await ctx.deleteMessage();
    return;
  } catch (error) {
    logger.debug({ err: error, chatId: ctx.chat.id }, 'Failed to delete client role message');
  }

  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (error) {
    logger.debug(
      { err: error, chatId: ctx.chat.id },
      'Failed to clear role selection keyboard for client',
    );
  }
};

export const applyClientRole = async (ctx: BotContext): Promise<void> => {
  const authUser = ctx.auth.user;

  const username = ctx.from?.username ?? authUser.username;
  const firstName = ctx.from?.first_name ?? authUser.firstName;
  const lastName = ctx.from?.last_name ?? authUser.lastName;
  const sessionPhone = ctx.session.phoneNumber;
  const authPhone = authUser.phone;
  const phone = sessionPhone ?? authPhone;

  const shouldEnsureRole = authUser.role !== 'client';
  const shouldUpdatePhone = Boolean(phone && authPhone !== phone);

  const restrictedStatuses = new Set(['suspended', 'banned', 'safe_mode']);
  const shouldPreserveStatus = restrictedStatuses.has(authUser.status);

  const nextStatus = shouldPreserveStatus ? authUser.status : 'active_client';
  let ensuredKeyboardNonce: string | undefined;

  if (shouldEnsureRole || shouldUpdatePhone) {
    try {
      ensuredKeyboardNonce = await ensureClientRole({
        telegramId: authUser.telegramId,
        username: username ?? undefined,
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
        phone: phone ?? undefined,
      });
    } catch (error) {
      logger.error(
        { err: error, telegramId: authUser.telegramId },
        'Failed to update client role in database',
      );
    }
  }

  authUser.role = 'client';
  authUser.status = nextStatus;
  authUser.username = username ?? undefined;
  authUser.firstName = firstName ?? undefined;
  authUser.lastName = lastName ?? undefined;
  if (!authUser.keyboardNonce && ensuredKeyboardNonce) {
    authUser.keyboardNonce = ensuredKeyboardNonce;
  }
  if (phone) {
    authUser.phone = phone;
    authUser.phoneVerified = true;
  }
  ctx.auth.isModerator = false;

  if (!shouldPreserveStatus) {
    ctx.session.isAuthenticated = true;
  }
  ctx.session.user = {
    id: authUser.telegramId,
    username: username ?? undefined,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
    phoneVerified: authUser.phoneVerified,
  };
  if (phone && !ctx.session.phoneNumber) {
    ctx.session.phoneNumber = phone;
  }

  clearOnboardingState(ctx);

  const identity = {
    ...toUserIdentity(ctx.from),
    telegramId: authUser.telegramId,
    username: username ?? undefined,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
    phone: phone ?? authUser.phone ?? undefined,
  };
  const city = getCityFromContext(ctx) ?? authUser.citySelected;

  try {
    await reportRoleSet(ctx.telegram, {
      user: identity,
      role: 'client',
      city,
    });
  } catch (error) {
    logger.error({ err: error, telegramId: authUser.telegramId }, 'Failed to report client role');
  }
};

export const showMenu = async (ctx: BotContext, prompt?: string): Promise<void> => {
  const role = ctx.auth?.user.role;
  if (!isClientChat(ctx, role)) {
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCbQuery('Меню доступно только в личном чате с ботом.');
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer menu callback for non-private chat');
      }
    } else if (typeof ctx.reply === 'function') {
      await ctx.reply('Меню доступно только в личном чате с ботом.');
    }
    return;
  }

  const uiState = ctx.session.ui;

  const city = getCityFromContext(ctx);
  if (!city) {
    uiState.pendingCityAction = CLIENT_MENU_CITY_ACTION;
    await askCity(ctx, 'Укажите город, чтобы продолжить.');
    return;
  }

  uiState.pendingCityAction = undefined;
  const cityLabel = CITY_LABEL[city];
  const baseText = prompt ?? clientMenuText();
  const miniStatus = copy.clientMiniStatus(cityLabel);
  const header = miniStatus ? `${miniStatus}\n\n${baseText}` : baseText;

  const keyboard = await buildClientMenuKeyboard(ctx);

  if (ctx.callbackQuery) {
    uiState.clientMenuVariant = undefined;

    try {
      await ctx.editMessageText(header, { reply_markup: keyboard });
      return;
    } catch (error) {
      logger.debug({ err: error, chatId: ctx.chat?.id }, 'Failed to edit client menu message');
    }
  }

  await sendClientMenu(ctx, header, keyboard);
};

export const registerClientMenu = (bot: Telegraf<BotContext>): void => {
  const clientRoleActions = [ROLE_CLIENT_ACTION, ROLE_PICK_CLIENT_ACTION] as const;

  for (const action of clientRoleActions) {
    bot.action(action, async (ctx) => {
      await applyClientRole(ctx);

      if (!isClientChat(ctx, ctx.auth?.user.role)) {
        await showMenu(ctx);
        return;
      }

      await removeRoleSelectionMessage(ctx);

      await applyClientCommands(ctx);

      try {
        await ctx.answerCbQuery();
      } catch (error) {
        logger.debug({ err: error }, 'Failed to answer client role callback');
      }

      await showMenu(ctx, 'Добро пожаловать! Чем можем помочь?');
    });
  }

  bot.action(CLIENT_MENU_ACTION, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await showMenu(ctx);
      return;
    }

    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer client menu callback');
    }

    await showMenu(ctx);
  });

  bot.action(CLIENT_MENU_REFRESH_ACTION, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await showMenu(ctx);
      return;
    }

    await logClientMenuClick(ctx, 'client_home_menu:refresh');

    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer client menu refresh callback');
    }

    await showMenu(ctx);
  });

  bot.action(CLIENT_MENU_SUPPORT_ACTION, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await showMenu(ctx);
      return;
    }

    await logClientMenuClick(ctx, 'client_home_menu:support');

    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer client menu support callback');
    }

    await promptClientSupport(ctx);
  });

  bot.action(CLIENT_MENU_PROFILE_ACTION, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await showMenu(ctx);
      return;
    }

    await logClientMenuClick(ctx, 'client_home_menu:profile');

    await renderProfileCardFromAction(
      ctx,
      {
        ...buildClientProfileOptions(),
        onAnswerError: (error) => {
          logger.debug({ err: error }, 'Failed to answer client menu profile callback');
        },
      },
    );
  });

  bot.action(CLIENT_MENU_CITY_SELECT_ACTION, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await showMenu(ctx);
      return;
    }

    const uiState = ctx.session.ui;
    uiState.pendingCityAction = CLIENT_MENU_CITY_ACTION;

    await logClientMenuClick(ctx, 'client_home_menu:city');

    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer client menu city callback');
    }

    await askCity(ctx, 'Выберите город:');
  });

  bot.action(CLIENT_MENU_SWITCH_ROLE_ACTION, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await showMenu(ctx);
      return;
    }

    await logClientMenuClick(ctx, 'client_home_menu:switch_role');

    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.debug({ err: error }, 'Failed to answer client menu switch role callback');
    }

    await hideClientMenu(ctx, 'Меняем роль — выберите подходящий вариант ниже.');
    const executorState = ensureExecutorState(ctx);
    executorState.awaitingRoleSelection = true;
    executorState.role = undefined;
    await presentRolePick(ctx);
  });

  bot.action(CITY_ACTION_PATTERN, async (ctx, next) => {
    if (ctx.session.ui?.pendingCityAction === CLIENT_MENU_CITY_ACTION) {
      ctx.session.ui.pendingCityAction = undefined;

      if (isClientChat(ctx, ctx.auth?.user.role)) {
        await showMenu(ctx);
      }
    }

    if (typeof next === 'function') {
      await next();
    }
  });

  bot.command('order', async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await ctx.reply('Меню доступно только в личном чате с ботом.');
      return;
    }

    await showMenu(ctx);
  });

  bot.command('support', async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      await ctx.reply('Поддержка доступна только в личном чате с ботом.');
      return;
    }

    await promptClientSupport(ctx);
  });

  bot.command('profile', async (ctx, next) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      if (typeof next === 'function') {
        await next();
      }
      return;
    }

    await renderProfileCard(ctx, buildClientProfileOptions());
  });

  bot.command('role', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Смена роли доступна только в личном чате с ботом.');
      return;
    }

    await hideClientMenu(ctx, 'Меняем роль — выберите подходящий вариант ниже.');
    const executorState = ensureExecutorState(ctx);
    executorState.awaitingRoleSelection = true;
    executorState.role = undefined;
    await presentRolePick(ctx);
  });

  bot.hears(CLIENT_MENU_TRIGGER, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      return;
    }

    await showMenu(ctx);
  });
};
