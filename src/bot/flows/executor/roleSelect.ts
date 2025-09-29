import type { Telegraf } from 'telegraf';

import { logger } from '../../../config';
import { hideClientMenu } from '../../../ui/clientMenu';
import { updateUserRole } from '../../../db/users';
import { EXECUTOR_COMMANDS } from '../../commands/sets';
import { setChatCommands } from '../../services/commands';
import type { BotContext, ExecutorRole } from '../../types';
import { ui } from '../../ui';
import { askCity, CITY_CONFIRM_STEP_ID } from '../common/citySelect';
import { ensureExecutorState } from './menu';
import { getExecutorRoleCopy } from '../../copy';
import {
  ROLE_SELECTION_BACK_ACTION,
  EXECUTOR_ROLE_PENDING_CITY_ACTION,
  EXECUTOR_KIND_COURIER_ACTION,
  EXECUTOR_KIND_DRIVER_ACTION,
} from './roleSelectionConstants';
import { clearOnboardingState } from '../../services/onboarding';
import { reportRoleSet, toUserIdentity } from '../../services/reports';

export const handleRoleSelection = async (ctx: BotContext, role: ExecutorRole): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    await ctx.answerCbQuery('Пожалуйста, продолжите в личных сообщениях с ботом.');
    return;
  }

  const state = ensureExecutorState(ctx);
  state.role = role;
  state.awaitingRoleSelection = true;
  state.roleSelectionStage = 'city';
  ctx.auth.user.role = 'executor';
  ctx.auth.user.executorKind = role;
  ctx.auth.user.status = 'active_executor';

  try {
    await updateUserRole({
      telegramId: ctx.auth.user.telegramId,
      role: 'executor',
      executorKind: role,
      status: 'active_executor',
      menuRole: 'courier',
    });
  } catch (error) {
    logger.error(
      { err: error, telegramId: ctx.auth.user.telegramId },
      'Failed to persist executor role selection',
    );
  }

  const { genitive } = getExecutorRoleCopy(role);
  await ctx.answerCbQuery(`Вы выбрали роль ${genitive}. Теперь определим город.`);

  let deleted = false;
  try {
    await ctx.deleteMessage();
    deleted = true;
  } catch (error) {
    logger.debug(
      { err: error, chatId: ctx.chat.id },
      'Failed to delete executor role selection message',
    );
  }

  if (!deleted) {
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch (error) {
      logger.debug(
        { err: error, chatId: ctx.chat.id },
        'Failed to clear role selection inline keyboard',
      );
    }
  }

  await setChatCommands(ctx.telegram, ctx.chat.id, EXECUTOR_COMMANDS, { showMenuButton: true });

  await hideClientMenu(ctx, 'Переключаемся…');
  ctx.session.ui.pendingCityAction = EXECUTOR_ROLE_PENDING_CITY_ACTION;
  await askCity(ctx, 'Сначала выбери город для работы', {
    homeAction: ROLE_SELECTION_BACK_ACTION,
    homeLabel: '⬅️ Назад',
  });
  await ui.trackStep(ctx, {
    id: CITY_CONFIRM_STEP_ID,
    homeAction: ROLE_SELECTION_BACK_ACTION,
  });
  clearOnboardingState(ctx);

  const identity = {
    ...toUserIdentity(ctx.from),
    telegramId: ctx.auth.user.telegramId,
    username: ctx.from?.username ?? ctx.auth.user.username ?? undefined,
    firstName: ctx.from?.first_name ?? ctx.auth.user.firstName ?? undefined,
    lastName: ctx.from?.last_name ?? ctx.auth.user.lastName ?? undefined,
    phone: ctx.auth.user.phone ?? ctx.session.phoneNumber ?? undefined,
  };
  const city = ctx.auth.user.citySelected ?? (ctx.chat?.type === 'private' ? ctx.session.city : undefined);

  try {
    await reportRoleSet(ctx.telegram, {
      user: identity,
      role: 'executor',
      executorRole: role,
      city,
    });
  } catch (error) {
    logger.error({ err: error, telegramId: ctx.auth.user.telegramId }, 'Failed to report executor role');
  }
};

export const registerExecutorRoleSelect = (bot: Telegraf<BotContext>): void => {
  bot.action(EXECUTOR_KIND_COURIER_ACTION, async (ctx) => {
    await handleRoleSelection(ctx, 'courier');
  });

  bot.action(EXECUTOR_KIND_DRIVER_ACTION, async (ctx) => {
    await handleRoleSelection(ctx, 'driver');
  });
};
