import { Telegraf } from 'telegraf';
import type {
  InlineKeyboardMarkup,
  Location as TelegramLocation,
} from 'telegraf/typings/core/types/typegram';

import { publishOrderToDriversChannel, type PublishOrderStatus } from '../../channels/ordersChannel';
import { logger } from '../../../config';
import { createOrder, markOrderAsCancelled } from '../../../db/orders';
import type { OrderRecord, OrderLocation, OrderPriceDetails } from '../../../types';
import {
  buildCustomerName,
  buildOrderSummary,
  resetClientOrderDraft,
  type CompletedOrderDraft,
} from '../../services/orders';
import {
  geocodeOrderLocation,
  geocodeTelegramLocation,
  isTwoGisLink,
} from '../../services/geocode';
import { estimateTaxiPrice, formatPriceAmount } from '../../services/pricing';
import { clearInlineKeyboard } from '../../services/cleanup';
import { ensurePrivateCallback, isPrivateChat } from '../../services/access';
import {
  buildConfirmCancelKeyboard,
  buildInlineKeyboard,
  buildUrlKeyboard,
  mergeInlineKeyboards,
  type KeyboardButton,
} from '../../keyboards/common';
import { buildOrderLocationsKeyboard } from '../../keyboards/orders';
import type { BotContext, ClientOrderDraftState } from '../../types';
import { ui } from '../../ui';
import { CLIENT_MENU, isClientChat, sendClientMenu } from '../../../ui/clientMenu';
import { CLIENT_MENU_ACTION, logClientMenuClick } from './menu';
import { CLIENT_TAXI_ORDER_AGAIN_ACTION, CLIENT_ORDERS_ACTION } from './orderActions';
import { ensureCitySelected } from '../common/citySelect';
import type { AppCity } from '../../../domain/cities';
import { dgBase } from '../../../utils/2gis';
import { reportOrderCreated, type UserIdentity } from '../../services/reports';
import {
  decodeRecentLocationId,
  encodeRecentLocationId,
  findRecentLocation,
  loadRecentLocations,
  rememberLocation,
} from '../../services/recentLocations';
import type { RecentLocationOption } from '../../services/recentLocations';
import { copy } from '../../copy';
import { buildStatusMessage } from '../../ui/status';
import { flowStart, flowComplete } from '../../../metrics/agg';
import { registerFlowRecovery } from '../recovery';

export const START_TAXI_ORDER_ACTION = 'client:order:taxi:start';
const CONFIRM_TAXI_ORDER_ACTION = 'client:order:taxi:confirm';
const CANCEL_TAXI_ORDER_ACTION = 'client:order:taxi:cancel';
const TAXI_RECENT_PICKUP_ACTION_PREFIX = 'client:order:taxi:recent:pickup';
const TAXI_RECENT_DROPOFF_ACTION_PREFIX = 'client:order:taxi:recent:dropoff';
const CALLBACK_ID_PATTERN = /([A-Za-z0-9_-]+)/;
const TAXI_RECENT_PICKUP_ACTION_PATTERN = new RegExp(
  `^${TAXI_RECENT_PICKUP_ACTION_PREFIX}:${CALLBACK_ID_PATTERN.source}`,
);
const TAXI_RECENT_DROPOFF_ACTION_PATTERN = new RegExp(
  `^${TAXI_RECENT_DROPOFF_ACTION_PREFIX}:${CALLBACK_ID_PATTERN.source}`,
);

const getDraft = (ctx: BotContext): ClientOrderDraftState => ctx.session.client.taxi;

const TAXI_STEP_ID = 'client:taxi:step';
const TAXI_MANUAL_ADDRESS_HINT_STEP_ID = 'client:taxi:hint:manual-address';
const TAXI_CONFIRMATION_HINT_STEP_ID = 'client:taxi:hint:confirmation';
const TAXI_GEOCODE_ERROR_STEP_ID = 'client:taxi:error:geocode';
const TAXI_CANCELLED_STEP_ID = 'client:taxi:cancelled';
const TAXI_CREATED_STEP_ID = 'client:taxi:created';
const TAXI_STATUS_STEP_ID = 'client:taxi:status';
const TAXI_CONFIRM_ERROR_STEP_ID = 'client:taxi:error:confirm';
const TAXI_CREATE_ERROR_STEP_ID = 'client:taxi:error:create';

type ClientPublishStatus = PublishOrderStatus | 'publish_failed';

const updateTaxiStep = async (
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboardMarkup,
) => {
  await ui.clear(ctx, { ids: TAXI_STEP_ID });

  return ui.step(ctx, {
    id: TAXI_STEP_ID,
    text,
    keyboard,
    homeAction: CLIENT_MENU_ACTION,
    recovery: { type: 'client:taxi:step' },
  });
};

const ADDRESS_INPUT_HINTS = [
  '• Отправьте ссылку 2ГИС на точку или организацию (поддерживаются /geo и /firm).',
  '• Поделитесь геопозицией через Telegram (скрепка → «Геопозиция»).',
  '• Введите адрес вручную — внимательно проверьте город, улицу и дом.',
] as const;

const buildAddressPrompt = (lines: string[]): string =>
  [...lines, ...ADDRESS_INPUT_HINTS].join('\n');

const buildTwoGisShortcutKeyboard = (city: AppCity): InlineKeyboardMarkup =>
  buildUrlKeyboard('🗺 Открыть 2ГИС', dgBase(city));

const remindManualAddressAccuracy = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: TAXI_MANUAL_ADDRESS_HINT_STEP_ID,
    text: '⚠️ При ручном вводе адреса укажите город, улицу и дом. Если есть ссылка 2ГИС или геопозиция, отправьте её.',
    cleanup: true,
  });
};

const remindConfirmationActions = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: TAXI_CONFIRMATION_HINT_STEP_ID,
    text: 'Используйте кнопки ниже, чтобы подтвердить или отменить заказ.',
    cleanup: true,
  });
};

const buildRecentLocationsKeyboard = async (
  ctx: BotContext,
  city: AppCity,
  kind: 'pickup' | 'dropoff',
  prefix: string,
) => {
  let recent: RecentLocationOption[] = [];
  try {
    recent = await loadRecentLocations(ctx.auth.user.telegramId, city, kind);
  } catch (error) {
    logger.warn(
      { err: error, city, kind, userId: ctx.auth.user.telegramId },
      'Failed to load recent taxi locations; continuing without suggestions',
    );
  }
  if (recent.length === 0) {
    return undefined;
  }

  const rows = recent.reduce<KeyboardButton[][]>((result, item) => {
    const encodedId = encodeRecentLocationId(item.locationId);
    if (!encodedId) {
      logger.warn(
        { locationId: item.locationId, prefix },
        'Skipping recent taxi location with invalid id',
      );
      return result;
    }

    const action = `${prefix}:${encodedId}`;
    if (action.length > 64) {
      logger.warn(
        { locationId: item.locationId, prefix },
        'Skipping recent taxi location with oversized callback data',
      );
      return result;
    }

    result.push([{ label: item.label, action }]);
    return result;
  }, []);

  if (rows.length === 0) {
    return undefined;
  }

  return buildInlineKeyboard(rows);
};

const requestPickupAddress = async (ctx: BotContext, city: AppCity): Promise<void> => {
  const shortcuts = buildTwoGisShortcutKeyboard(city);
  const recent = await buildRecentLocationsKeyboard(
    ctx,
    city,
    'pickup',
    TAXI_RECENT_PICKUP_ACTION_PREFIX,
  );
  await updateTaxiStep(
    ctx,
    buildAddressPrompt(['Отправьте точку подачи такси одним из способов:']),
    mergeInlineKeyboards(shortcuts, recent) ?? shortcuts,
  );
};

const requestDropoffAddress = async (
  ctx: BotContext,
  city: AppCity,
  pickup: CompletedOrderDraft['pickup'],
): Promise<void> => {
  const shortcuts = buildTwoGisShortcutKeyboard(city);
  const recent = await buildRecentLocationsKeyboard(
    ctx,
    city,
    'dropoff',
    TAXI_RECENT_DROPOFF_ACTION_PREFIX,
  );
  await updateTaxiStep(
    ctx,
    buildAddressPrompt([
      `Адрес подачи: ${pickup.address}.`,
      '',
      'Теперь отправьте пункт назначения одним из способов:',
    ]),
    mergeInlineKeyboards(shortcuts, recent) ?? shortcuts,
  );
};

const handleGeocodingFailure = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: TAXI_GEOCODE_ERROR_STEP_ID,
    text: 'Не удалось распознать адрес. Укажите лучше на карте или через 2ГИС.',
    cleanup: true,
  });
};

const applyPickupDetails = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  pickup: CompletedOrderDraft['pickup'],
): Promise<void> => {
  draft.pickup = pickup;
  draft.stage = 'collectingDropoff';

  const city = ctx.session.city;
  if (!city) {
    logger.warn('Taxi order pickup collected without selected city');
    draft.stage = 'idle';
    return;
  }

  try {
    await rememberLocation(ctx.auth.user.telegramId, city, 'pickup', pickup);
  } catch (error) {
    logger.warn(
      { err: error, city, userId: ctx.auth.user.telegramId },
      'Failed to remember taxi pickup location; continuing without persistence',
    );
  }

  await requestDropoffAddress(ctx, city, pickup);
};

type TaxiOrderDraft = ClientOrderDraftState & {
  pickup: OrderLocation;
  dropoff: OrderLocation;
  price: OrderPriceDetails;
};

const isTaxiOrderDraftReady = (draft: ClientOrderDraftState): draft is TaxiOrderDraft =>
  Boolean(draft.pickup && draft.dropoff && draft.price);

const applyDropoffDetails = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  dropoff: CompletedOrderDraft['dropoff'],
): Promise<void> => {
  draft.dropoff = dropoff;

  if (!draft.pickup) {
    logger.warn('Taxi order draft is missing pickup after dropoff geocode');
    draft.stage = 'idle';
    return;
  }

  draft.price = estimateTaxiPrice(draft.pickup, dropoff);
  draft.stage = 'awaitingConfirmation';

  const city = ctx.session.city;
  if (!city) {
    logger.warn('Taxi order draft missing city when confirming dropoff');
    draft.stage = 'idle';
    return;
  }

  try {
    await rememberLocation(ctx.auth.user.telegramId, city, 'dropoff', dropoff);
  } catch (error) {
    logger.warn(
      { err: error, city, userId: ctx.auth.user.telegramId },
      'Failed to remember taxi dropoff location; continuing without persistence',
    );
  }

  if (isTaxiOrderDraftReady(draft)) {
    await showConfirmation(ctx, draft, city);
  }
};

const applyPickupAddress = async (ctx: BotContext, draft: ClientOrderDraftState, text: string) => {
  const pickup = await geocodeOrderLocation(text, { city: ctx.session.city });
  if (!pickup) {
    await handleGeocodingFailure(ctx);
    return;
  }
  await applyPickupDetails(ctx, draft, pickup);

  if (!isTwoGisLink(text)) {
    await remindManualAddressAccuracy(ctx);
  }
};

const buildConfirmationKeyboard = () =>
  buildConfirmCancelKeyboard(CONFIRM_TAXI_ORDER_ACTION, CANCEL_TAXI_ORDER_ACTION);

const buildOrderAgainKeyboard = () =>
  buildInlineKeyboard([[{ label: 'Заказать ещё', action: CLIENT_TAXI_ORDER_AGAIN_ACTION }]]);

const showConfirmation = async (
  ctx: BotContext,
  draft: TaxiOrderDraft,
  city: AppCity,
): Promise<void> => {
  const summary = buildOrderSummary(draft, {
    title: '🚕 Предварительный заказ такси',
    pickupLabel: '📍 Подача',
    dropoffLabel: '🎯 Назначение',
    distanceLabel: '📏 Расстояние',
    priceLabel: '💰 Оценка стоимости',
  });

  const locationsKeyboard = buildOrderLocationsKeyboard(city, draft.pickup, draft.dropoff);
  const confirmationKeyboard = buildConfirmationKeyboard();
  const keyboard = mergeInlineKeyboards(locationsKeyboard, confirmationKeyboard);
  const result = await updateTaxiStep(ctx, summary, keyboard);
  draft.confirmationMessageId = result?.messageId;
};

const applyDropoffAddress = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  text: string,
): Promise<void> => {
  const dropoff = await geocodeOrderLocation(text, { city: ctx.session.city });
  if (!dropoff) {
    await handleGeocodingFailure(ctx);
    return;
  }
  await applyDropoffDetails(ctx, draft, dropoff);

  if (!isTwoGisLink(text)) {
    await remindManualAddressAccuracy(ctx);
  }
};

const applyPickupLocation = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  location: TelegramLocation,
): Promise<void> => {
  const pickup = await geocodeTelegramLocation(location, { label: 'Геопозиция подачи' });
  if (!pickup) {
    await handleGeocodingFailure(ctx);
    return;
  }

  await applyPickupDetails(ctx, draft, pickup);
};

const applyDropoffLocation = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  location: TelegramLocation,
): Promise<void> => {
  const dropoff = await geocodeTelegramLocation(location, { label: 'Геопозиция назначения' });
  if (!dropoff) {
    await handleGeocodingFailure(ctx);
    return;
  }

  await applyDropoffDetails(ctx, draft, dropoff);
};

const cancelOrderDraft = async (ctx: BotContext, draft: ClientOrderDraftState): Promise<void> => {
  await clearInlineKeyboard(ctx, draft.confirmationMessageId);
  resetClientOrderDraft(draft);
  flowComplete('taxi_order', false);

  const keyboard = buildOrderAgainKeyboard();
  await ui.step(ctx, {
    id: TAXI_CANCELLED_STEP_ID,
    text: 'Оформление заказа отменено.',
    cleanup: true,
    homeAction: CLIENT_MENU_ACTION,
    keyboard,
  });
  await sendClientMenu(ctx, 'Готово. Хотите оформить новый заказ?');
};

const notifyOrderCreated = async (
  ctx: BotContext,
  order: OrderRecord,
  publishStatus: ClientPublishStatus,
): Promise<void> => {
  const isSuccessful = publishStatus !== 'publish_failed';
  flowComplete('taxi_order', isSuccessful);

  const statusLabel =
    publishStatus === 'missing_channel'
      ? 'Заказ создан. Оператор свяжется вручную.'
      : publishStatus === 'publish_failed'
      ? 'Заказ создан, но не опубликован. Оператор свяжется вручную.'
      : 'Заказ отправлен водителям. Ожидаем отклика.';
  const statusEmoji = publishStatus === 'published' || publishStatus === 'already_published' ? '⏳' : '⚠️';
  const statusPayload = { emoji: statusEmoji, label: statusLabel };
  const { text: statusText, reply_markup } = buildStatusMessage(
    statusEmoji,
    statusLabel,
    CLIENT_ORDERS_ACTION,
    CLIENT_MENU_ACTION,
  );

  await ui.step(ctx, {
    id: TAXI_STATUS_STEP_ID,
    text: statusText,
    keyboard: reply_markup,
    cleanup: true,
    homeAction: CLIENT_MENU_ACTION,
    recovery: { type: 'client:taxi:status', payload: statusPayload },
  });

  const lines = [
    publishStatus === 'publish_failed'
      ? `Заказ №${order.id} записан, но не был отправлен водителям.`
      : `Заказ №${order.id} успешно создан.`,
    `Стоимость по расчёту: ${formatPriceAmount(order.price.amount, order.price.currency)}.`,
  ];

  if (publishStatus === 'missing_channel') {
    lines.push('⚠️ Канал исполнителей не настроен. Мы свяжемся с вами вручную.');
  }
  if (publishStatus === 'publish_failed') {
    lines.push('⚠️ Не удалось отправить заказ водителям. Мы свяжемся с вами вручную.');
  }

  const customer: UserIdentity = {
    telegramId: ctx.auth.user.telegramId,
    username: ctx.auth.user.username ?? undefined,
    firstName: ctx.auth.user.firstName ?? undefined,
    lastName: ctx.auth.user.lastName ?? undefined,
    phone: ctx.session.phoneNumber ?? ctx.auth.user.phone ?? undefined,
  };

  await reportOrderCreated(ctx.telegram, { order, customer, publishStatus });

  await ui.step(ctx, {
    id: TAXI_CREATED_STEP_ID,
    text: lines.join('\n'),
    cleanup: true,
    homeAction: CLIENT_MENU_ACTION,
    keyboard: buildOrderAgainKeyboard(),
  });
  await sendClientMenu(ctx, 'Готово. Хотите оформить новый заказ?');
};

const confirmOrder = async (ctx: BotContext, draft: ClientOrderDraftState): Promise<void> => {
  if (!isTaxiOrderDraftReady(draft)) {
    await ui.step(ctx, {
      id: TAXI_CONFIRM_ERROR_STEP_ID,
      text: 'Не удалось подтвердить заказ: отсутствуют данные адресов.',
      cleanup: true,
    });
    resetClientOrderDraft(draft);
    return;
  }

  if (draft.stage === 'creatingOrder') {
    await ctx.answerCbQuery('Заказ уже обрабатывается.');
    return;
  }

  draft.stage = 'creatingOrder';

  const city = ctx.session.city;
  if (!city) {
    logger.error('Attempted to confirm taxi order without selected city');
    draft.stage = 'idle';
    await ui.step(ctx, {
      id: TAXI_CONFIRM_ERROR_STEP_ID,
      text: 'Не выбран город. Выберите город через меню и начните оформление заново.',
      cleanup: true,
    });
    return;
  }

  try {
    let order: OrderRecord;
    try {
      order = await createOrder({
        kind: 'taxi',
        city,
        clientId: ctx.auth.user.telegramId,
        clientPhone: ctx.session.phoneNumber,
        customerName: buildCustomerName(ctx),
        customerUsername: ctx.auth.user.username,
        clientComment: draft.notes,
        pickup: draft.pickup,
        dropoff: draft.dropoff,
        price: draft.price,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create taxi order');
      flowComplete('taxi_order', false);
      await ui.step(ctx, {
        id: TAXI_CREATE_ERROR_STEP_ID,
        text: 'Не удалось создать заказ. Попробуйте позже.',
        cleanup: true,
      });
      await sendClientMenu(ctx, 'Не удалось создать заказ. Выберите следующее действие.');
      return;
    }

    let publishStatus: ClientPublishStatus;
    try {
      const publishResult = await publishOrderToDriversChannel(ctx.telegram, order.id);
      publishStatus = publishResult.status;
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, 'Failed to publish taxi order');
      publishStatus = 'publish_failed';

      try {
        order = (await markOrderAsCancelled(order.id)) ?? order;
      } catch (statusError) {
        logger.error(
          { err: statusError, orderId: order.id },
          'Failed to cancel taxi order after publish failure',
        );
      }

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Заказ записан, оператор свяжется вручную.', { show_alert: true });
      }
    }

    await notifyOrderCreated(ctx, order, publishStatus);
  } catch (error) {
    logger.error({ err: error }, 'Failed to finalize taxi order confirmation');
    flowComplete('taxi_order', false);
    await ui.step(ctx, {
      id: TAXI_CREATE_ERROR_STEP_ID,
      text: 'Не удалось создать заказ. Попробуйте позже.',
      cleanup: true,
    });
    await sendClientMenu(ctx, 'Не удалось создать заказ. Выберите следующее действие.');
  } finally {
    await clearInlineKeyboard(ctx, draft.confirmationMessageId);
    resetClientOrderDraft(draft);
  }
};

const processCancellationText = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  text: string,
): Promise<boolean> => {
  const normalized = text.trim().toLowerCase();
  if (normalized === '/cancel' || normalized === 'отмена' || normalized === 'cancel') {
    await cancelOrderDraft(ctx, draft);
    return true;
  }

  return false;
};

const handleIncomingText = async (ctx: BotContext, next: () => Promise<void>): Promise<void> => {
  if (!isPrivateChat(ctx)) {
    await next();
    return;
  }

  const message = ctx.message;
  if (!message || !('text' in message)) {
    await next();
    return;
  }

  const text = message.text.trim();
  if (text.startsWith('/')) {
    const draft = getDraft(ctx);
    const cancelled = await processCancellationText(ctx, draft, text);
    if (!cancelled) {
      await next();
    }
    return;
  }

  const draft = getDraft(ctx);
  switch (draft.stage) {
    case 'collectingPickup':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await applyPickupAddress(ctx, draft, text);
      break;
    case 'collectingDropoff':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await applyDropoffAddress(ctx, draft, text);
      break;
    case 'awaitingConfirmation': {
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await remindConfirmationActions(ctx);
      break;
    }
    default:
      await next();
  }
};

const handleIncomingLocation = async (
  ctx: BotContext,
  next: () => Promise<void>,
): Promise<void> => {
  if (!isPrivateChat(ctx)) {
    await next();
    return;
  }

  const message = ctx.message;
  if (!message || !('location' in message) || !message.location) {
    await next();
    return;
  }

  const draft = getDraft(ctx);

  switch (draft.stage) {
    case 'collectingPickup':
      await applyPickupLocation(ctx, draft, message.location);
      return;
    case 'collectingDropoff':
      await applyDropoffLocation(ctx, draft, message.location);
      return;
    case 'awaitingConfirmation':
      await remindConfirmationActions(ctx);
      return;
    default:
      await next();
  }
};

const resolveTaxiCity = (ctx: BotContext): AppCity | undefined =>
  ctx.session.city ?? ctx.auth.user.citySelected ?? undefined;

const resumeTaxiFlowStep = async (ctx: BotContext): Promise<boolean> => {
  const draft = getDraft(ctx);

  switch (draft.stage) {
    case 'collectingPickup': {
      const city = resolveTaxiCity(ctx);
      if (!city) {
        return false;
      }
      await requestPickupAddress(ctx, city);
      return true;
    }
    case 'collectingDropoff': {
      const city = resolveTaxiCity(ctx);
      if (!city || !draft.pickup) {
        return false;
      }
      await requestDropoffAddress(ctx, city, draft.pickup);
      return true;
    }
    case 'awaitingConfirmation': {
      const city = resolveTaxiCity(ctx);
      if (!city || !isTaxiOrderDraftReady(draft)) {
        return false;
      }
      await showConfirmation(ctx, draft, city);
      return true;
    }
    default:
      return false;
  }
};

registerFlowRecovery('client:taxi:step', async (ctx) => resumeTaxiFlowStep(ctx));

registerFlowRecovery('client:taxi:status', async (ctx, payload) => {
  const details =
    payload && typeof payload === 'object'
      ? (payload as { emoji?: unknown; label?: unknown })
      : {};
  const emoji = typeof details.emoji === 'string' ? details.emoji : '⏳';
  const label =
    typeof details.label === 'string' ? details.label : 'Заказ отправлен водителям. Ожидаем отклика.';

  const { text, reply_markup } = buildStatusMessage(
    emoji,
    label,
    CLIENT_ORDERS_ACTION,
    CLIENT_MENU_ACTION,
  );

  await ui.step(ctx, {
    id: TAXI_STATUS_STEP_ID,
    text,
    keyboard: reply_markup,
    cleanup: true,
    homeAction: CLIENT_MENU_ACTION,
    recovery: { type: 'client:taxi:status', payload: { emoji, label } },
  });

  return true;
});

const handleStart = async (ctx: BotContext): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, undefined, 'Оформление заказа доступно только в личном чате с ботом.'))) {
    return;
  }

  const city = await ensureCitySelected(ctx, 'Выберите город, чтобы оформить заказ.');
  if (!city) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Сначала выберите город.');
    }
    return;
  }

  const draft = getDraft(ctx);
  resetClientOrderDraft(draft);
  draft.stage = 'collectingPickup';
  resetClientOrderDraft(ctx.session.client.delivery);

  await logClientMenuClick(ctx, 'client_home_menu:taxi');
  flowStart('taxi_order');

  await requestPickupAddress(ctx, city);
};

const handleConfirmationAction = async (ctx: BotContext): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, undefined, 'Подтвердите заказ в личном чате с ботом.'))) {
    return;
  }

  const draft = getDraft(ctx);
  await confirmOrder(ctx, draft);
};

const handleCancellationAction = async (ctx: BotContext): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, 'Оформление отменено.', 'Отмените заказ в личном чате с ботом.'))) {
    return;
  }

  const draft = getDraft(ctx);
  await cancelOrderDraft(ctx, draft);
};

export const startTaxiOrder = handleStart;

const handleRecentPickup = async (ctx: BotContext, locationId: string): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, undefined, 'Выберите адрес в личном чате с ботом.'))) {
    return;
  }

  const draft = getDraft(ctx);
  if (draft.stage !== 'collectingPickup') {
    await ctx.answerCbQuery(copy.expiredButton);
    return;
  }

  const city = ctx.session.city;
  if (!city) {
    await ctx.answerCbQuery('Сначала выберите город.');
    return;
  }

  let location: OrderLocation | null = null;
  try {
    location = await findRecentLocation(ctx.auth.user.telegramId, city, 'pickup', locationId);
  } catch (error) {
    logger.warn(
      { err: error, city, userId: ctx.auth.user.telegramId, locationId },
      'Failed to resolve recent taxi pickup location; falling back to manual input',
    );
  }
  if (!location) {
    await ctx.answerCbQuery(copy.expiredButton);
    return;
  }

  await applyPickupDetails(ctx, draft, location);
  await ctx.answerCbQuery('Адрес подставлен.');
};

const handleRecentDropoff = async (ctx: BotContext, locationId: string): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, undefined, 'Выберите адрес в личном чате с ботом.'))) {
    return;
  }

  const draft = getDraft(ctx);
  if (draft.stage !== 'collectingDropoff') {
    await ctx.answerCbQuery(copy.expiredButton);
    return;
  }

  const city = ctx.session.city;
  if (!city) {
    await ctx.answerCbQuery('Сначала выберите город.');
    return;
  }

  let location: OrderLocation | null = null;
  try {
    location = await findRecentLocation(ctx.auth.user.telegramId, city, 'dropoff', locationId);
  } catch (error) {
    logger.warn(
      { err: error, city, userId: ctx.auth.user.telegramId, locationId },
      'Failed to resolve recent taxi dropoff location; falling back to manual input',
    );
  }
  if (!location) {
    await ctx.answerCbQuery(copy.expiredButton);
    return;
  }

  await applyDropoffDetails(ctx, draft, location);
  await ctx.answerCbQuery('Адрес подставлен.');
};

export const registerTaxiOrderFlow = (bot: Telegraf<BotContext>): void => {
  bot.action(START_TAXI_ORDER_ACTION, async (ctx) => {
    await handleStart(ctx);
  });

  bot.action(CONFIRM_TAXI_ORDER_ACTION, async (ctx) => {
    await handleConfirmationAction(ctx);
  });

  bot.action(CANCEL_TAXI_ORDER_ACTION, async (ctx) => {
    await handleCancellationAction(ctx);
  });

  bot.action(CLIENT_TAXI_ORDER_AGAIN_ACTION, async (ctx) => {
    await handleStart(ctx);
  });

  bot.action(TAXI_RECENT_PICKUP_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const encodedId = match?.[1];
    const locationId = encodedId ? decodeRecentLocationId(encodedId) : null;
    if (!locationId) {
      await ctx.answerCbQuery(copy.expiredButton);
      return;
    }

    await handleRecentPickup(ctx, locationId);
  });

  bot.action(TAXI_RECENT_DROPOFF_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const encodedId = match?.[1];
    const locationId = encodedId ? decodeRecentLocationId(encodedId) : null;
    if (!locationId) {
      await ctx.answerCbQuery(copy.expiredButton);
      return;
    }

    await handleRecentDropoff(ctx, locationId);
  });

  bot.hears(CLIENT_MENU.taxi, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      return;
    }

    await handleStart(ctx);
  });

  bot.command('taxi', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }

    const city = await ensureCitySelected(ctx, 'Выберите город, чтобы оформить заказ.');
    if (!city) {
      return;
    }

    const draft = getDraft(ctx);
    resetClientOrderDraft(draft);
    draft.stage = 'collectingPickup';
    resetClientOrderDraft(ctx.session.client.delivery);

    await requestPickupAddress(ctx, city);
  });

  bot.on('location', async (ctx, next) => {
    await handleIncomingLocation(ctx, next);
  });

  bot.on('text', async (ctx, next) => {
    await handleIncomingText(ctx, next);
  });
};
