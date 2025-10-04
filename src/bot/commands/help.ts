import { Telegraf } from 'telegraf';

import type { BotContext, ClientOrderDraftState } from '../types';

const joinLines = (lines: Array<string | undefined>): string =>
  lines.filter((line): line is string => line !== undefined).join('\n');

const formatAddressLine = (
  label: string,
  location: ClientOrderDraftState['pickup'] | ClientOrderDraftState['dropoff'] | undefined,
): string | undefined => {
  if (!location?.address) {
    return undefined;
  }

  return `${label}: ${location.address}.`;
};

const CANCEL_HINT = 'Чтобы отменить оформление, отправьте /cancel.';

const buildDeliveryHelp = (draft: ClientOrderDraftState): string | undefined => {
  switch (draft.stage) {
    case 'collectingPickup':
      return joinLines([
        '📦 Оформляем доставку.',
        'Отправьте ссылку 2ГИС на точку забора посылки. Нажмите «Открыть 2ГИС» в сообщении бота или пришлите ссылку на выбранное место.',
        'Если подходящий адрес уже сохранён, выберите его из списка под сообщением.',
        CANCEL_HINT,
      ]);
    case 'collectingDropoff':
      return joinLines([
        '📦 Оформляем доставку.',
        formatAddressLine('📦 Забор', draft.pickup),
        '',
        'Теперь отправьте ссылку 2ГИС на адрес доставки. Можно снова открыть 2ГИС через кнопку или выбрать недавний адрес.',
        CANCEL_HINT,
      ]);
    case 'collectingRecipientPhone':
      return joinLines([
        '📦 Оформляем доставку.',
        formatAddressLine('📮 Доставка', draft.dropoff),
        '',
        'Укажите телефон получателя в формате +7XXXXXXXXXX. Если получатель вы, можно отправить свой номер.',
        CANCEL_HINT,
      ]);
    case 'collectingComment': {
      const details: Array<string | undefined> = [
        formatAddressLine('📦 Забор', draft.pickup),
        formatAddressLine('📮 Доставка', draft.dropoff),
        draft.recipientPhone ? `📞 Телефон получателя: ${draft.recipientPhone}.` : undefined,
      ];

      return joinLines([
        '📦 Оформляем доставку.',
        ...details,
        details.some((line) => line) ? '' : undefined,
        'Добавьте обязательный комментарий для курьера:',
        '• Что нужно забрать или доставить.',
        '• Кому передать и как связаться.',
        '• Подъезд, код домофона и другие ориентиры.',
        CANCEL_HINT,
      ]);
    }
    case 'awaitingConfirmation':
      return joinLines([
        '📦 Проверьте данные доставки.',
        'Используйте кнопки под сообщением, чтобы подтвердить заказ или отменить оформление.',
        'Если нужно исправить адреса или детали, отмените оформление и начните заново.',
      ]);
    case 'creatingOrder':
      return joinLines([
        '⏳ Заказ отправлен курьерам.',
        'Мы уведомим, как только кто-то примет доставку. Пожалуйста, оставайтесь на связи.',
      ]);
    default:
      return undefined;
  }
};

const buildTaxiHelp = (draft: ClientOrderDraftState): string | undefined => {
  switch (draft.stage) {
    case 'collectingPickup':
      return joinLines([
        '🚕 Оформляем поездку.',
        'Отправьте ссылку 2ГИС на точку подачи такси. Нажмите «Открыть 2ГИС» под сообщением или пришлите ссылку на выбранное место.',
        'Можно выбрать сохранённый адрес из списка под сообщением.',
        CANCEL_HINT,
      ]);
    case 'collectingDropoff':
      return joinLines([
        '🚕 Оформляем поездку.',
        formatAddressLine('📍 Подача', draft.pickup),
        '',
        'Теперь пришлите ссылку 2ГИС на пункт назначения. Можно снова воспользоваться кнопкой или недавним адресом.',
        CANCEL_HINT,
      ]);
    case 'collectingRecipientPhone':
      return joinLines([
        '🚕 Оформляем поездку.',
        'Укажите контактный телефон пассажира в формате +7XXXXXXXXXX. Если водитель должен связаться с другим человеком, отправьте его номер.',
        CANCEL_HINT,
      ]);
    case 'collectingComment': {
      const details: Array<string | undefined> = [
        formatAddressLine('📍 Подача', draft.pickup),
        formatAddressLine('🎯 Назначение', draft.dropoff),
      ];

      return joinLines([
        '🚕 Оформляем поездку.',
        ...details,
        details.some((line) => line) ? '' : undefined,
        'Добавьте комментарий для водителя:',
        '• Где вас встретить и какие есть ориентиры.',
        '• Сколько пассажиров или багажа.',
        '• Нужны ли особые условия поездки.',
        CANCEL_HINT,
      ]);
    }
    case 'awaitingConfirmation':
      return joinLines([
        '🚕 Проверьте детали поездки.',
        'Используйте кнопки под сообщением, чтобы подтвердить поездку или отменить оформление.',
        'Если требуется изменить адреса, отмените оформление и начните заново.',
      ]);
    case 'creatingOrder':
      return joinLines([
        '⏳ Заказ отправлен водителям.',
        'Мы напишем, как только водитель примет поездку. Пожалуйста, держите телефон под рукой.',
      ]);
    default:
      return undefined;
  }
};

const buildOrderHelp = (ctx: BotContext): string | undefined => {
  const client = ctx.session?.client;
  if (!client) {
    return undefined;
  }

  const deliveryHelp = buildDeliveryHelp(client.delivery);
  if (deliveryHelp) {
    return deliveryHelp;
  }

  const taxiHelp = buildTaxiHelp(client.taxi);
  if (taxiHelp) {
    return taxiHelp;
  }

  return undefined;
};

const buildSupportHelp = (ctx: BotContext): string | undefined => {
  if (ctx.session?.support?.status !== 'awaiting_message') {
    return undefined;
  }

  return joinLines([
    '🆘 Вы на шаге обращения в поддержку.',
    'Опишите проблему одним сообщением — мы передадим его модератору.',
    'Если хотите вернуться в меню без сообщения, отправьте /start.',
  ]);
};

const buildExecutorHelp = (ctx: BotContext): string | undefined => {
  const executor = ctx.session?.executor;
  if (!executor || !executor.awaitingRoleSelection) {
    return undefined;
  }

  const stage = executor.roleSelectionStage ?? 'role';

  switch (stage) {
    case 'role':
      return joinLines([
        'Выбираете роль в сервисе.',
        'Нажмите «Клиент» или «Исполнитель» в сообщении с выбором роли. Если сообщение не видно, отправьте /start.',
      ]);
    case 'executorKind':
      return joinLines([
        'Выбираете специализацию исполнителя.',
        'Используйте кнопки «Курьер» или «Водитель» под сообщением. Кнопка «Назад» вернёт к выбору роли.',
      ]);
    case 'city':
      return joinLines([
        'Подтвердите город для заказов.',
        'Выберите город из списка или используйте /city, чтобы поменять его.',
      ]);
    default:
      return joinLines([
        'Продолжайте выбор роли через /start — следуйте подсказкам под сообщениями.',
      ]);
  }
};

const GENERAL_HELP_TEXT = joinLines([
  'ℹ️ Бот помогает оформить доставку и поездку.',
  'Используйте /start, чтобы открыть главное меню, и кнопки под сообщениями для навигации.',
  'Команды: /city — сменить город, /help — показать подсказку, /start — вернуться в меню.',
  'Если нужна поддержка, выберите пункт «Поддержка» в меню или отправьте /start.',
]);

export const buildHelpMessage = (ctx: BotContext): string => {
  return (
    buildOrderHelp(ctx)
    ?? buildSupportHelp(ctx)
    ?? buildExecutorHelp(ctx)
    ?? GENERAL_HELP_TEXT
  );
};

export const handleHelp = async (ctx: BotContext): Promise<void> => {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Пожалуйста, воспользуйтесь командой в личном чате с ботом.');
    return;
  }

  const message = buildHelpMessage(ctx);
  await ctx.reply(message);
};

export const registerHelpCommand = (bot: Telegraf<BotContext>): void => {
  bot.command('help', handleHelp);
};

export const __testing__ = {
  joinLines,
  formatAddressLine,
  buildDeliveryHelp,
  buildTaxiHelp,
  buildOrderHelp,
  buildSupportHelp,
  buildExecutorHelp,
};
