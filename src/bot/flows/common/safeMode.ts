import type { Telegraf } from 'telegraf';

import type { BotContext } from '../../types';
import { SAFE_MODE_CARD_ACTIONS, buildSafeModeCardText, showSafeModeCard } from '../../ui/safeModeCard';
import { buildProfileCardText, createProfileCardActionHandler } from './profileCard';
import { askCity } from './citySelect';
import { promptClientSupport } from '../client/support';

const SAFE_MODE_PROFILE_ACTION = SAFE_MODE_CARD_ACTIONS.profile;
const SAFE_MODE_CITY_ACTION = SAFE_MODE_CARD_ACTIONS.city;
const SAFE_MODE_SUPPORT_ACTION = SAFE_MODE_CARD_ACTIONS.support;
const SAFE_MODE_MENU_ACTION = SAFE_MODE_CARD_ACTIONS.menu;

export const isSafeModeSession = (ctx: BotContext): boolean =>
  ctx.session.safeMode === true
  || ctx.session.isDegraded === true
  || ctx.auth?.user.status === 'safe_mode';

export const registerSafeModeActions = (bot: Telegraf<BotContext>): void => {
  bot.action(
    SAFE_MODE_PROFILE_ACTION,
    createProfileCardActionHandler({
      backAction: SAFE_MODE_MENU_ACTION,
      homeAction: SAFE_MODE_MENU_ACTION,
    }),
  );

  bot.action(SAFE_MODE_MENU_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      try {
        await ctx.answerCbQuery('Безопасный режим доступен только в личном чате.');
      } catch {
        // Ignore
      }
      return;
    }

    try {
      await ctx.answerCbQuery();
    } catch {
      // Ignore
    }

    await showSafeModeCard(ctx);
  });

  bot.action(SAFE_MODE_CITY_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      try {
        await ctx.answerCbQuery('Сменить город можно только в личном чате.');
      } catch {
        // Ignore
      }
      return;
    }

    try {
      await ctx.answerCbQuery();
    } catch {
      // Ignore
    }

    await askCity(ctx, 'Смените город:');
  });

  bot.action(SAFE_MODE_SUPPORT_ACTION, async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      try {
        await ctx.answerCbQuery('Обратитесь в поддержку из личного чата.');
      } catch {
        // Ignore
      }
      return;
    }

    try {
      await ctx.answerCbQuery();
    } catch {
      // Ignore
    }

    await promptClientSupport(ctx);
  });
};

export const __testing__ = {
  buildSafeModeCardText,
  buildProfileCardText,
  SAFE_MODE_ACTIONS: SAFE_MODE_CARD_ACTIONS,
};
