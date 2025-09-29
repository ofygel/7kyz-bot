import { Markup, type Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import { CITIES_ORDER, CITY_LABEL, isAppCity, type AppCity } from '../../../domain/cities';
import { CitySelectionError, setUserCitySelected } from '../../../services/users';
import { logger } from '../../../config';
import type { BotContext } from '../../types';
import { resetClientOrderDraft } from '../../services/orders';
import { ui } from '../../ui';
import { copy } from '../../copy';
import { ROLE_SELECTION_BACK_ACTION, EXECUTOR_ROLE_PENDING_CITY_ACTION } from '../executor/roleSelectionConstants';
import { clearOnboardingState } from '../../services/onboarding';
import { reportCitySet, toUserIdentity } from '../../services/reports';

export const CITY_CONFIRM_STEP_ID = 'common:city:confirm';

const CLIENT_MENU_HOME_ACTION = 'client:menu:show';
const EXECUTOR_MENU_HOME_ACTION = 'executor:menu:refresh';

export const CITY_ACTION_PATTERN = /^city:([a-z]+)$/i;

const buildCityKeyboard = (): InlineKeyboardMarkup =>
  Markup.inlineKeyboard(
    CITIES_ORDER.map((city) => [Markup.button.callback(CITY_LABEL[city], `city:${city}`)]),
  ).reply_markup as InlineKeyboardMarkup;

const resolveHomeAction = (ctx: BotContext): string => {
  if (ctx.session.executor?.roleSelectionStage === 'city') {
    return ROLE_SELECTION_BACK_ACTION;
  }

  const pending = ctx.session.ui?.pendingCityAction;
  if (pending === 'clientMenu') {
    return CLIENT_MENU_HOME_ACTION;
  }
  if (pending === 'executorMenu') {
    return EXECUTOR_MENU_HOME_ACTION;
  }
  if (pending === EXECUTOR_ROLE_PENDING_CITY_ACTION) {
    return ROLE_SELECTION_BACK_ACTION;
  }

  const role = ctx.auth?.user.role;
  const isModerator = ctx.auth?.isModerator === true;
  if (isModerator || role === 'client' || role === 'guest') {
    return CLIENT_MENU_HOME_ACTION;
  }

  return EXECUTOR_MENU_HOME_ACTION;
};

const hasActiveOrder = (ctx: BotContext): boolean => {
  if (ctx.auth.user.hasActiveOrder) {
    return true;
  }

  const executorJobs = ctx.session.executor?.jobs;
  if (executorJobs?.stage === 'inProgress') {
    return true;
  }

  if (typeof executorJobs?.activeOrderId === 'number') {
    return true;
  }

  return false;
};

const applyCitySelection = (ctx: BotContext, city: AppCity): void => {
  const previousCity = ctx.auth.user.citySelected;
  ctx.auth.user.citySelected = city;

  if (ctx.chat?.type === 'private') {
    ctx.session.city = city;
  }

  if (previousCity && previousCity !== city && ctx.session?.client) {
    resetClientOrderDraft(ctx.session.client.taxi);
    resetClientOrderDraft(ctx.session.client.delivery);
  }
};

export const getCityFromContext = (ctx: BotContext): AppCity | undefined => {
  if (ctx.auth.user.citySelected) {
    return ctx.auth.user.citySelected;
  }

  return ctx.chat?.type === 'private' ? ctx.session.city ?? undefined : undefined;
};

export interface AskCityOptions {
  homeAction?: string;
  homeLabel?: string;
}

export const askCity = async (
  ctx: BotContext,
  title = 'Выберите город, чтобы продолжить работу с ботом:',
  options: AskCityOptions = {},
): Promise<void> => {
  if (!ctx.chat) {
    return;
  }

  const keyboard = buildCityKeyboard();
  const homeAction = options.homeAction ?? resolveHomeAction(ctx);
  const needsBackLabel = homeAction === ROLE_SELECTION_BACK_ACTION;
  const homeLabel = options.homeLabel ?? (needsBackLabel ? '⬅️ Назад' : undefined);

  if (homeAction === ROLE_SELECTION_BACK_ACTION && ctx.session.executor) {
    ctx.session.executor.awaitingRoleSelection = true;
    ctx.session.executor.roleSelectionStage = 'city';
  }

  const showBackTip = homeAction === ROLE_SELECTION_BACK_ACTION && Boolean(homeLabel);
  const restrictionNotice = hasActiveOrder(ctx)
    ? 'Сменить город можно после завершения активного заказа.'
    : undefined;

  const baseText = restrictionNotice ? `${title}\n\n${restrictionNotice}` : title;
  const stepText = showBackTip && homeLabel
    ? `${baseText}\n\nЕсли хотите вернуться, нажмите «${homeLabel}».`
    : baseText;

  await ui.step(ctx, {
    id: CITY_CONFIRM_STEP_ID,
    text: stepText,
    keyboard,
    homeAction,
    homeLabel,
  });
};

export const ensureCitySelected = async (
  ctx: BotContext,
  title?: string,
  options?: AskCityOptions,
): Promise<AppCity | null> => {
  const city = getCityFromContext(ctx);
  if (city) {
    return city;
  }

  await askCity(ctx, title, options);
  return null;
};

export const registerCityAction = (bot: Telegraf<BotContext>): void => {
  bot.action(CITY_ACTION_PATTERN, async (ctx, next) => {
    const match = ctx.match;
    const slug = Array.isArray(match) ? match[1] : undefined;
    if (!slug || !isAppCity(slug)) {
      await ctx.answerCbQuery('Неизвестный город.');
      return;
    }

    const city = slug as AppCity;
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.answerCbQuery('Не удалось определить пользователя.');
      return;
    }

    if (hasActiveOrder(ctx)) {
      await ctx.answerCbQuery('Сменить город можно после завершения активного заказа.', {
        show_alert: true,
      });
      return;
    }

    try {
      await setUserCitySelected(telegramId, city);
    } catch (error) {
      if (error instanceof CitySelectionError) {
        await ctx.answerCbQuery(copy.serviceUnavailable, { show_alert: true });
        if (ctx.chat?.id) {
          try {
            await ctx.reply('Техническая ошибка, попробуйте позже');
          } catch (replyError) {
            logger.warn(
              { err: replyError, chatId: ctx.chat.id },
              'Failed to notify user about city selection error',
            );
            if (ctx.telegram?.sendMessage) {
              try {
                await ctx.telegram.sendMessage(ctx.chat.id, 'Техническая ошибка, попробуйте позже');
              } catch (sendError) {
                logger.error(
                  { err: sendError, chatId: ctx.chat.id },
                  'Failed to send city selection error notification',
                );
              }
            }
          }
        }
        return;
      }

      throw error;
    }
    applyCitySelection(ctx, city);

    await ctx.answerCbQuery(`Город: ${CITY_LABEL[city]}`);

    const confirmationText = `Город установлен: ${CITY_LABEL[city]}`;

    const authUser = ctx.auth?.user;
    if (authUser) {
      const identity = {
        ...toUserIdentity(ctx.from),
        telegramId: authUser.telegramId,
        username: ctx.from?.username ?? authUser.username ?? undefined,
        firstName: ctx.from?.first_name ?? authUser.firstName ?? undefined,
        lastName: ctx.from?.last_name ?? authUser.lastName ?? undefined,
        phone: authUser.phone ?? ctx.session.phoneNumber ?? undefined,
      };

      try {
        await reportCitySet(ctx.telegram, {
          user: identity,
          city,
          role: authUser.role,
          executorRole: authUser.executorKind,
        });
      } catch (error) {
        logger.error({ err: error, telegramId: authUser.telegramId }, 'Failed to report city selection');
      }
    }

    let stepResult: Awaited<ReturnType<typeof ui.step>>;
    try {
      stepResult = await ui.step(ctx, {
        id: CITY_CONFIRM_STEP_ID,
        text: confirmationText,
        homeAction: resolveHomeAction(ctx),
      });
    } catch (error) {
      logger.debug(
        { err: error, chatId: ctx.chat?.id },
        'Failed to update city selection step, falling back to direct edit',
      );
    }

    if (!stepResult || stepResult.sent) {
      try {
        await ctx.editMessageText(confirmationText);
      } catch {
        try {
          await ctx.reply(confirmationText);
        } catch {
          // Ignore message errors, selection is already stored.
        }
      }
    }

    if (ctx.session.ui?.pendingCityAction === EXECUTOR_ROLE_PENDING_CITY_ACTION) {
      ctx.session.ui.pendingCityAction = 'executorMenu';
    }

    if (ctx.session.executor?.roleSelectionStage === 'city') {
      ctx.session.executor.roleSelectionStage = undefined;
      ctx.session.executor.awaitingRoleSelection = false;
      clearOnboardingState(ctx);
    }

    if (typeof next === 'function') {
      await next();
    }
  });
};
