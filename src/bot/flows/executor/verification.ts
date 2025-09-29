import { Markup, Telegraf } from 'telegraf';

import type { BotContext, ExecutorRole } from '../../types';
import { getExecutorRoleCopy } from '../../copy';
import { presentRolePick } from '../../commands/start';
import {
  EXECUTOR_MENU_ACTION,
  EXECUTOR_VERIFICATION_ACTION,
  ensureExecutorState,
} from './menu';
import { ui, type UiStepResult } from '../../ui';

const SUPPORT_USERNAME = 'support_seven';
const SUPPORT_LINK = `https://t.me/${SUPPORT_USERNAME}`;

const ROLE_DOCUMENT_REQUIREMENTS: Record<ExecutorRole, string[]> = {
  courier: [
    'Фото удостоверения личности (лицевая сторона).',
    'Фото удостоверения личности (оборотная сторона).',
    'Селфи с удостоверением личности в руках.',
  ],
  driver: [
    'Фото водительского удостоверения (лицевая сторона).',
    'Фото водительского удостоверения (оборотная сторона).',
    'Селфи с водительским удостоверением в руках.',
  ],
};

const buildRequirementsList = (role: ExecutorRole): string[] => {
  const requirements = ROLE_DOCUMENT_REQUIREMENTS[role] ?? ROLE_DOCUMENT_REQUIREMENTS.courier;
  return requirements.map((item, index) => `${index + 1}. ${item}`);
};

const buildVerificationInfoText = (role: ExecutorRole): string => {
  const copy = getExecutorRoleCopy(role);
  const requirements = buildRequirementsList(role);

  return [
    '🛡️ Проверка документов',
    '',
    `Чтобы подключиться к заказам ${copy.genitive}, отправьте документы в личные сообщения @${SUPPORT_USERNAME}.`,
    '',
    'Что подготовить:',
    ...requirements,
    '',
    'Отправьте файлы и вопросы напрямую в поддержку — команда поможет проверить документы и ответит на уточнения.',
  ].join('\n');
};

const buildVerificationKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.url('Написать в поддержку', SUPPORT_LINK)],
    [Markup.button.callback('⬅️ Назад в меню', EXECUTOR_MENU_ACTION)],
  ]).reply_markup;

export const VERIFICATION_PROMPT_STEP_ID = 'executor:verification:info';
export const EXECUTOR_ROLE_SWITCH_ACTION = 'executor:verification:switch-role';
export const EXECUTOR_VERIFICATION_GUIDE_ACTION = 'executor:verification:guide';

export const showExecutorVerificationPrompt = async (
  ctx: BotContext,
  role: ExecutorRole,
): Promise<UiStepResult | undefined> => {
  const stepResult = await ui.step(ctx, {
    id: VERIFICATION_PROMPT_STEP_ID,
    text: buildVerificationInfoText(role),
    keyboard: buildVerificationKeyboard(),
    cleanup: true,
    homeAction: EXECUTOR_MENU_ACTION,
  });

  return stepResult;
};

export const startExecutorVerification = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const state = ensureExecutorState(ctx);
  const role = state.role;

  if (!role) {
    await presentRolePick(ctx, { withHint: true });
    return;
  }

  await showExecutorVerificationPrompt(ctx, role);
};

const handleRoleSwitch = async (ctx: BotContext): Promise<void> => {
  await ctx.answerCbQuery('Выберите роль заново.');
  await presentRolePick(ctx, { withHint: true });
};

const handleGuide = async (ctx: BotContext): Promise<void> => {
  const state = ensureExecutorState(ctx);
  const role = state.role;
  if (!role) {
    await ctx.answerCbQuery();
    return;
  }

  const infoText = buildVerificationInfoText(role);
  try {
    await ctx.answerCbQuery('Отправили информацию о документах.');
  } catch {
    // Ignore callback errors.
  }

  await ctx.reply(infoText, {
    reply_markup: buildVerificationKeyboard(),
  });
};

export const registerExecutorVerification = (bot: Telegraf<BotContext>): void => {
  bot.action(EXECUTOR_VERIFICATION_ACTION, async (ctx) => {
    await ctx.answerCbQuery();
    await startExecutorVerification(ctx);
  });

  bot.action(EXECUTOR_ROLE_SWITCH_ACTION, async (ctx) => {
    await handleRoleSwitch(ctx);
  });

  bot.action(EXECUTOR_VERIFICATION_GUIDE_ACTION, async (ctx) => {
    await handleGuide(ctx);
  });

  bot.hears(/документ/i, async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      if (typeof next === 'function') {
        await next();
      }
      return;
    }

    await startExecutorVerification(ctx);
  });
};

export const __private__ = {
  buildVerificationInfoText,
  buildVerificationKeyboard,
};
