import { Telegraf } from 'telegraf';
import type {
  InlineKeyboardMarkup,
  Location as TelegramLocation,
} from 'telegraf/typings/core/types/typegram';

import { publishOrderToDriversChannel, type PublishOrderStatus } from '../../channels/ordersChannel';
import { logger } from '../../../config';
import { createOrder, markOrderAsCancelled } from '../../../db/orders';
import type { OrderRecord, OrderLocation } from '../../../types';
import {
  buildCustomerName,
  buildOrderSummary,
  isOrderDraftComplete,
  resetClientOrderDraft,
  type CompletedOrderDraft,
} from '../../services/orders';
import {
  geocodeOrderLocation,
  geocodeTelegramLocation,
  isTwoGisLink,
} from '../../services/geocode';
import {
  estimateDeliveryPrice,
  formatPriceAmount,
} from '../../services/pricing';
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
import { CLIENT_DELIVERY_ORDER_AGAIN_ACTION, CLIENT_ORDERS_ACTION } from './orderActions';
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
import { normalizeE164 } from '../../../utils/phone';
import { buildStatusMessage } from '../../ui/status';
import { flowStart, flowComplete } from '../../../metrics/agg';
import { registerFlowRecovery } from '../recovery';

export const START_DELIVERY_ORDER_ACTION = 'client:order:delivery:start';
const CONFIRM_DELIVERY_ORDER_ACTION = 'client:order:delivery:confirm';
const CANCEL_DELIVERY_ORDER_ACTION = 'client:order:delivery:cancel';
const DELIVERY_ADDRESS_TYPE_PRIVATE_ACTION = 'client:order:delivery:address-type:private';
const DELIVERY_ADDRESS_TYPE_APARTMENT_ACTION = 'client:order:delivery:address-type:apartment';
const DELIVERY_RECENT_PICKUP_ACTION_PREFIX = 'client:order:delivery:recent:pickup';
const DELIVERY_RECENT_DROPOFF_ACTION_PREFIX = 'client:order:delivery:recent:dropoff';
const CALLBACK_ID_PATTERN = /([A-Za-z0-9_-]+)/;
const DELIVERY_RECENT_PICKUP_ACTION_PATTERN = new RegExp(
  `^${DELIVERY_RECENT_PICKUP_ACTION_PREFIX}:${CALLBACK_ID_PATTERN.source}`,
);
const DELIVERY_RECENT_DROPOFF_ACTION_PATTERN = new RegExp(
  `^${DELIVERY_RECENT_DROPOFF_ACTION_PREFIX}:${CALLBACK_ID_PATTERN.source}`,
);

const getDraft = (ctx: BotContext): ClientOrderDraftState => ctx.session.client.delivery;

const DELIVERY_STEP_ID = 'client:delivery:step';
const DELIVERY_MANUAL_ADDRESS_HINT_STEP_ID = 'client:delivery:hint:manual-address';
const DELIVERY_CONFIRMATION_HINT_STEP_ID = 'client:delivery:hint:confirmation';
const DELIVERY_COMMENT_REMINDER_STEP_ID = 'client:delivery:hint:comment';
const DELIVERY_GEOCODE_ERROR_STEP_ID = 'client:delivery:error:geocode';
const DELIVERY_SAVE_ERROR_STEP_ID = 'client:delivery:error:save';
const DELIVERY_CANCELLED_STEP_ID = 'client:delivery:cancelled';
const DELIVERY_CREATED_STEP_ID = 'client:delivery:created';
const DELIVERY_STATUS_STEP_ID = 'client:delivery:status';
const DELIVERY_CONFIRM_ERROR_STEP_ID = 'client:delivery:error:confirm';
const DELIVERY_CREATE_ERROR_STEP_ID = 'client:delivery:error:create';
const DELIVERY_ADDRESS_TYPE_HINT_STEP_ID = 'client:delivery:hint:address-type';
const DELIVERY_ADDRESS_DETAILS_ERROR_STEP_ID = 'client:delivery:error:address-details';
const DELIVERY_RECIPIENT_PHONE_ERROR_STEP_ID = 'client:delivery:error:recipient-phone';

type ClientPublishStatus = PublishOrderStatus | 'publish_failed';

export const normaliseRecipientPhone = (value: string): string | undefined => {
  const result = normalizeE164(value);
  return result.ok ? result.e164 : undefined;
};

const updateDeliveryStep = async (
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboardMarkup,
) => {
  await ui.clear(ctx, { ids: DELIVERY_STEP_ID });

  return ui.step(ctx, {
    id: DELIVERY_STEP_ID,
    text,
    keyboard,
    homeAction: CLIENT_MENU_ACTION,
    recovery: { type: 'client:delivery:step' },
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
    id: DELIVERY_MANUAL_ADDRESS_HINT_STEP_ID,
    text: '⚠️ При ручном вводе адреса укажите город, улицу, дом и ориентиры. Если есть ссылка 2ГИС или геопозиция, отправьте её.',
    cleanup: true,
  });
};

const buildAddressTypeKeyboard = () =>
  buildInlineKeyboard([
    [
      { label: '🏠 Частный дом', action: DELIVERY_ADDRESS_TYPE_PRIVATE_ACTION },
      { label: '🏢 Многоквартирный дом', action: DELIVERY_ADDRESS_TYPE_APARTMENT_ACTION },
    ],
  ]);

const requestAddressType = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
): Promise<void> => {
  if (!draft.pickup || !draft.dropoff) {
    logger.warn('Attempted to request address type without collected locations');
    draft.stage = 'idle';
    return;
  }

  await updateDeliveryStep(
    ctx,
    [
      `Адрес забора: ${draft.pickup.address}.`,
      `Адрес доставки: ${draft.dropoff.address}.`,
      '',
      'Выберите тип адреса доставки:',
    ].join('\n'),
    buildAddressTypeKeyboard(),
  );
};

const remindAddressTypeSelection = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: DELIVERY_ADDRESS_TYPE_HINT_STEP_ID,
    text: 'Выберите тип адреса доставки с помощью кнопок ниже.',
    cleanup: true,
  });
};

const requestApartment = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
): Promise<void> => {
  if (!draft.dropoff) {
    logger.warn('Attempted to request apartment without dropoff location');
    draft.stage = 'idle';
    return;
  }

  await updateDeliveryStep(
    ctx,
    [
      `Адрес доставки: ${draft.dropoff.address}.`,
      '',
      'Укажите номер квартиры получателя (например, 45 или 12Б):',
    ].join('\n'),
  );
};

const requestEntrance = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
): Promise<void> => {
  if (!draft.dropoff) {
    logger.warn('Attempted to request entrance without dropoff location');
    draft.stage = 'idle';
    return;
  }

  await updateDeliveryStep(
    ctx,
    [
      `Адрес доставки: ${draft.dropoff.address}.`,
      '',
      'Укажите подъезд (например, 3 или 3А):',
    ].join('\n'),
  );
};

const requestFloor = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
): Promise<void> => {
  if (!draft.dropoff) {
    logger.warn('Attempted to request floor without dropoff location');
    draft.stage = 'idle';
    return;
  }

  await updateDeliveryStep(
    ctx,
    [
      `Адрес доставки: ${draft.dropoff.address}.`,
      '',
      'Укажите этаж (например, 5):',
    ].join('\n'),
  );
};

const requestRecipientPhone = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
): Promise<void> => {
  if (!draft.dropoff) {
    logger.warn('Attempted to request recipient phone without dropoff location');
    draft.stage = 'idle';
    return;
  }

  await updateDeliveryStep(
    ctx,
    [
      `Адрес доставки: ${draft.dropoff.address}.`,
      '',
      'Укажите номер телефона получателя (в формате +77001234567):',
    ].join('\n'),
  );
};

const remindAddressDetailsRequirement = async (
  ctx: BotContext,
  message: string,
): Promise<void> => {
  await ui.step(ctx, {
    id: DELIVERY_ADDRESS_DETAILS_ERROR_STEP_ID,
    text: message,
    cleanup: true,
  });
};

const remindRecipientPhoneRequirement = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: DELIVERY_RECIPIENT_PHONE_ERROR_STEP_ID,
    text: copy.invalidPhone(),
    cleanup: true,
  });
};

const remindConfirmationActions = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: DELIVERY_CONFIRMATION_HINT_STEP_ID,
    text: 'Используйте кнопки ниже, чтобы подтвердить или отменить заказ.',
    cleanup: true,
  });
};

const remindDeliveryCommentRequirement = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: DELIVERY_COMMENT_REMINDER_STEP_ID,
    text: 'Комментарий обязателен. Опишите, что передать курьеру и кому, укажите подъезд, код домофона и контакты.',
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
      'Failed to load recent delivery locations; continuing without suggestions',
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
        'Skipping recent delivery location with invalid id',
      );
      return result;
    }

    const action = `${prefix}:${encodedId}`;
    if (action.length > 64) {
      logger.warn(
        { locationId: item.locationId, prefix },
        'Skipping recent delivery location with oversized callback data',
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
    DELIVERY_RECENT_PICKUP_ACTION_PREFIX,
  );
  await updateDeliveryStep(
    ctx,
    buildAddressPrompt(['Укажите точку забора посылки одним из способов:']),
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
    DELIVERY_RECENT_DROPOFF_ACTION_PREFIX,
  );
  await updateDeliveryStep(
    ctx,
    buildAddressPrompt([
      `Адрес забора: ${pickup.address}.`,
      '',
      'Теперь отправьте адрес доставки одним из способов:',
    ]),
    mergeInlineKeyboards(shortcuts, recent) ?? shortcuts,
  );
};

const requestDeliveryComment = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
): Promise<void> => {
  if (!draft.pickup || !draft.dropoff) {
    return;
  }

  const details: string[] = [];
  if (typeof draft.isPrivateHouse === 'boolean') {
    const typeLabel = draft.isPrivateHouse ? 'Частный дом' : 'Многоквартирный дом';
    details.push(`🏠 Тип адреса: ${typeLabel}.`);
  }

  if (!draft.isPrivateHouse) {
    if (draft.apartment) {
      details.push(`🚪 Квартира: ${draft.apartment}.`);
    }
    if (draft.entrance) {
      details.push(`📮 Подъезд: ${draft.entrance}.`);
    }
    if (draft.floor) {
      details.push(`⬆️ Этаж: ${draft.floor}.`);
    }
  }

  if (draft.recipientPhone) {
    details.push(`📞 Телефон получателя: ${draft.recipientPhone}.`);
  }

  await updateDeliveryStep(
    ctx,
    [
      `Адрес забора: ${draft.pickup.address}.`,
      `Адрес доставки: ${draft.dropoff.address}.`,
      ...(details.length > 0 ? ['', ...details] : []),
      '',
      'Добавьте обязательный комментарий для курьера:',
      '• Что нужно забрать или доставить.',
      '• Кому передать и как с ним связаться.',
      '• Подъезд, код домофона и другие ориентиры.',
    ].join('\n'),
  );
};

const handleGeocodingFailure = async (ctx: BotContext): Promise<void> => {
  await ui.step(ctx, {
    id: DELIVERY_GEOCODE_ERROR_STEP_ID,
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
    logger.warn('Delivery order pickup collected without selected city');
    draft.stage = 'idle';
    return;
  }

  try {
    await rememberLocation(ctx.auth.user.telegramId, city, 'pickup', pickup);
  } catch (error) {
    logger.warn(
      { err: error, city, userId: ctx.auth.user.telegramId },
      'Failed to remember delivery pickup location; continuing without persistence',
    );
  }

  await requestDropoffAddress(ctx, city, pickup);
};

const applyDropoffDetails = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  dropoff: CompletedOrderDraft['dropoff'],
): Promise<void> => {
  draft.dropoff = dropoff;

  if (!draft.pickup) {
    logger.warn('Delivery order draft is missing pickup after dropoff geocode');
    draft.stage = 'idle';
    return;
  }

  draft.price = estimateDeliveryPrice(draft.pickup, dropoff);
  draft.isPrivateHouse = undefined;
  draft.apartment = undefined;
  draft.entrance = undefined;
  draft.floor = undefined;
  draft.recipientPhone = undefined;
  draft.stage = 'selectingAddressType';

  const city = ctx.session.city;
  if (city) {
    try {
      await rememberLocation(ctx.auth.user.telegramId, city, 'dropoff', dropoff);
    } catch (error) {
      logger.warn(
        { err: error, city, userId: ctx.auth.user.telegramId },
        'Failed to remember delivery dropoff location; continuing without persistence',
      );
    }
  }

  await requestAddressType(ctx, draft);
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
  buildConfirmCancelKeyboard(CONFIRM_DELIVERY_ORDER_ACTION, CANCEL_DELIVERY_ORDER_ACTION);

const buildOrderAgainKeyboard = () =>
  buildInlineKeyboard([[{ label: 'Заказать ещё', action: CLIENT_DELIVERY_ORDER_AGAIN_ACTION }]]);

const buildDeliveryInstructions = (
  draft: CompletedOrderDraft,
  comment?: string,
): string[] => {
  const lines: string[] = [
    `🏠 Тип адреса: ${draft.isPrivateHouse ? 'Частный дом' : 'Многоквартирный дом'}.`,
    `📞 Телефон получателя: ${draft.recipientPhone}.`,
  ];

  if (!draft.isPrivateHouse) {
    lines.push(`🚪 Квартира: ${draft.apartment ?? '—'}.`);
    lines.push(`📮 Подъезд: ${draft.entrance ?? '—'}.`);
    lines.push(`⬆️ Этаж: ${draft.floor ?? '—'}.`);
  }

  if (comment) {
    lines.push(`📝 Комментарий: ${comment}`);
  }

  lines.push('Подтвердите заказ или отмените оформление.');

  return lines;
};

const showConfirmation = async (ctx: BotContext, draft: CompletedOrderDraft): Promise<void> => {
  const comment = draft.notes?.trim();
  const summary = buildOrderSummary(draft, {
    title: '🚚 Доставка курьером',
    pickupLabel: '📦 Забор',
    dropoffLabel: '📮 Доставка',
    distanceLabel: '📏 Расстояние',
    priceLabel: '💰 Оценка стоимости',
    instructions: buildDeliveryInstructions(draft, comment),
  });

  const city = ctx.session.city;
  if (!city) {
    logger.warn('Delivery order confirmation attempted without selected city');
    return;
  }

  const locationsKeyboard = buildOrderLocationsKeyboard(city, draft.pickup, draft.dropoff);
  const confirmationKeyboard = buildConfirmationKeyboard();
  const keyboard = mergeInlineKeyboards(locationsKeyboard, confirmationKeyboard);
  const result = await updateDeliveryStep(ctx, summary, keyboard);
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
  const pickup = await geocodeTelegramLocation(location, { label: 'Геопозиция забора' });
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
  const dropoff = await geocodeTelegramLocation(location, { label: 'Геопозиция доставки' });
  if (!dropoff) {
    await handleGeocodingFailure(ctx);
    return;
  }

  await applyDropoffDetails(ctx, draft, dropoff);
};

const applyAddressTypeSelection = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  isPrivateHouse: boolean,
): Promise<void> => {
  draft.isPrivateHouse = isPrivateHouse;

  if (isPrivateHouse) {
    draft.apartment = undefined;
    draft.entrance = undefined;
    draft.floor = undefined;
    draft.stage = 'collectingRecipientPhone';
    await requestRecipientPhone(ctx, draft);
    return;
  }

  draft.stage = 'collectingApartment';
  await requestApartment(ctx, draft);
};

const applyApartmentDetails = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  text: string,
): Promise<void> => {
  const value = text.trim();
  if (!value) {
    await remindAddressDetailsRequirement(ctx, 'Номер квартиры обязателен. Укажите его, чтобы курьер нашёл адрес.');
    return;
  }

  draft.apartment = value;
  draft.stage = 'collectingEntrance';
  await requestEntrance(ctx, draft);
};

const applyEntranceDetails = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  text: string,
): Promise<void> => {
  const value = text.trim();
  if (!value) {
    await remindAddressDetailsRequirement(ctx, 'Укажите подъезд, чтобы курьер быстрее нашёл вход.');
    return;
  }

  draft.entrance = value;
  draft.stage = 'collectingFloor';
  await requestFloor(ctx, draft);
};

const applyFloorDetails = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  text: string,
): Promise<void> => {
  const value = text.trim();
  if (!value) {
    await remindAddressDetailsRequirement(ctx, 'Укажите этаж, чтобы курьер подготовился заранее.');
    return;
  }

  draft.floor = value;
  draft.stage = 'collectingRecipientPhone';
  await requestRecipientPhone(ctx, draft);
};

const applyRecipientPhone = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  text: string,
): Promise<void> => {
  const phone = normaliseRecipientPhone(text);
  if (!phone) {
    await remindRecipientPhoneRequirement(ctx);
    return;
  }

  draft.recipientPhone = phone;
  draft.stage = 'collectingComment';
  await requestDeliveryComment(ctx, draft);
};

const applyDeliveryComment = async (
  ctx: BotContext,
  draft: ClientOrderDraftState,
  text: string,
): Promise<void> => {
  const trimmed = text.trim();
  if (!trimmed) {
    await remindDeliveryCommentRequirement(ctx);
    return;
  }

  draft.notes = trimmed;
  draft.stage = 'awaitingConfirmation';

  if (isOrderDraftComplete(draft)) {
    await showConfirmation(ctx, draft);
    return;
  }

  logger.warn('Delivery order draft is incomplete after collecting comment');
  draft.stage = 'idle';
  await ui.step(ctx, {
    id: DELIVERY_SAVE_ERROR_STEP_ID,
    text: 'Не удалось сохранить заказ. Попробуйте начать заново.',
    cleanup: true,
  });
};

const cancelOrderDraft = async (ctx: BotContext, draft: ClientOrderDraftState): Promise<void> => {
  await clearInlineKeyboard(ctx, draft.confirmationMessageId);
  resetClientOrderDraft(draft);
  flowComplete('delivery_order', false);

  const keyboard = buildOrderAgainKeyboard();
  await ui.step(ctx, {
    id: DELIVERY_CANCELLED_STEP_ID,
    text: 'Оформление доставки отменено.',
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
  flowComplete('delivery_order', isSuccessful);

  const statusLabel =
    publishStatus === 'missing_channel'
      ? 'Заказ создан. Оператор свяжется вручную.'
      : publishStatus === 'publish_failed'
      ? 'Заказ создан, но не опубликован. Оператор свяжется вручную.'
      : 'Заказ отправлен исполнителям. Ожидаем отклика.';
  const statusEmoji = publishStatus === 'published' || publishStatus === 'already_published' ? '⏳' : '⚠️';
  const statusPayload = { emoji: statusEmoji, label: statusLabel };
  const { text: statusText, reply_markup } = buildStatusMessage(
    statusEmoji,
    statusLabel,
    CLIENT_ORDERS_ACTION,
    CLIENT_MENU_ACTION,
  );

  await ui.step(ctx, {
    id: DELIVERY_STATUS_STEP_ID,
    text: statusText,
    keyboard: reply_markup,
    cleanup: true,
    homeAction: CLIENT_MENU_ACTION,
    recovery: { type: 'client:delivery:status', payload: statusPayload },
  });

  const lines = [
    publishStatus === 'publish_failed'
      ? `Заказ на доставку №${order.id} записан, но не был отправлен исполнителям.`
      : `Заказ на доставку №${order.id} создан.`,
    `Стоимость по расчёту: ${formatPriceAmount(order.price.amount, order.price.currency)}.`,
  ];

  if (publishStatus === 'missing_channel') {
    lines.push('⚠️ Канал исполнителей не настроен. Мы свяжемся с вами вручную.');
  }
  if (publishStatus === 'publish_failed') {
    lines.push('⚠️ Не удалось отправить заказ исполнителям. Мы свяжемся с вами вручную.');
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
    id: DELIVERY_CREATED_STEP_ID,
    text: lines.join('\n'),
    cleanup: true,
    homeAction: CLIENT_MENU_ACTION,
    keyboard: buildOrderAgainKeyboard(),
  });
  await sendClientMenu(ctx, 'Готово. Хотите оформить новый заказ?');
};

const confirmOrder = async (ctx: BotContext, draft: ClientOrderDraftState): Promise<void> => {
  if (!isOrderDraftComplete(draft)) {
    await ui.step(ctx, {
      id: DELIVERY_CONFIRM_ERROR_STEP_ID,
      text: 'Не удалось подтвердить заказ: отсутствуют данные адресов.',
      cleanup: true,
    });
    resetClientOrderDraft(draft);
    return;
  }

  const comment = draft.notes?.trim();
  if (!comment) {
    draft.stage = 'collectingComment';
    await remindDeliveryCommentRequirement(ctx);
    await requestDeliveryComment(ctx, draft);
    return;
  }

  if (draft.stage === 'creatingOrder') {
    await ctx.answerCbQuery('Заказ уже обрабатывается.');
    return;
  }

  draft.stage = 'creatingOrder';

  const city = ctx.session.city;
  if (!city) {
    logger.error('Attempted to confirm delivery order without selected city');
    draft.stage = 'idle';
    await ui.step(ctx, {
      id: DELIVERY_CONFIRM_ERROR_STEP_ID,
      text: 'Не выбран город. Выберите город через меню и начните оформление заново.',
      cleanup: true,
    });
    return;
  }

  try {
    let order: OrderRecord;
    try {
      order = await createOrder({
        kind: 'delivery',
        city,
        clientId: ctx.auth.user.telegramId,
        clientPhone: ctx.session.phoneNumber,
        recipientPhone: draft.recipientPhone,
        customerName: buildCustomerName(ctx),
        customerUsername: ctx.auth.user.username,
        clientComment: draft.notes,
        apartment: draft.apartment,
        entrance: draft.entrance,
        floor: draft.floor,
        isPrivateHouse: draft.isPrivateHouse,
        pickup: draft.pickup,
        dropoff: draft.dropoff,
        price: draft.price,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create delivery order');
      flowComplete('delivery_order', false);
      await ui.step(ctx, {
        id: DELIVERY_CREATE_ERROR_STEP_ID,
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
      logger.error({ err: error, orderId: order.id }, 'Failed to publish delivery order');
      publishStatus = 'publish_failed';

      try {
        order = (await markOrderAsCancelled(order.id)) ?? order;
      } catch (statusError) {
        logger.error(
          { err: statusError, orderId: order.id },
          'Failed to cancel delivery order after publish failure',
        );
      }

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Заказ записан, оператор свяжется вручную.', { show_alert: true });
      }
    }

    await notifyOrderCreated(ctx, order, publishStatus);
  } catch (error) {
    logger.error({ err: error }, 'Failed to finalize delivery order confirmation');
    flowComplete('delivery_order', false);
    await ui.step(ctx, {
      id: DELIVERY_CREATE_ERROR_STEP_ID,
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
    case 'selectingAddressType':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await remindAddressTypeSelection(ctx);
      break;
    case 'collectingApartment':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await applyApartmentDetails(ctx, draft, text);
      break;
    case 'collectingEntrance':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await applyEntranceDetails(ctx, draft, text);
      break;
    case 'collectingFloor':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await applyFloorDetails(ctx, draft, text);
      break;
    case 'collectingRecipientPhone':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await applyRecipientPhone(ctx, draft, text);
      break;
    case 'collectingComment':
      if (await processCancellationText(ctx, draft, text)) {
        return;
      }
      await applyDeliveryComment(ctx, draft, text);
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
    case 'selectingAddressType':
      await remindAddressTypeSelection(ctx);
      return;
    case 'collectingApartment':
      await remindAddressDetailsRequirement(ctx, 'Отправьте номер квартиры текстом.');
      return;
    case 'collectingEntrance':
      await remindAddressDetailsRequirement(ctx, 'Отправьте номер подъезда текстом.');
      return;
    case 'collectingFloor':
      await remindAddressDetailsRequirement(ctx, 'Отправьте этаж текстом.');
      return;
    case 'collectingRecipientPhone':
      await remindRecipientPhoneRequirement(ctx);
      return;
    case 'collectingComment':
      await remindDeliveryCommentRequirement(ctx);
      return;
    case 'awaitingConfirmation':
      await remindConfirmationActions(ctx);
      return;
    default:
      await next();
  }
};

const resolveDeliveryCity = (ctx: BotContext): AppCity | undefined =>
  ctx.session.city ?? ctx.auth.user.citySelected ?? undefined;

const resumeDeliveryFlowStep = async (ctx: BotContext): Promise<boolean> => {
  const draft = getDraft(ctx);

  switch (draft.stage) {
    case 'collectingPickup': {
      const city = resolveDeliveryCity(ctx);
      if (!city) {
        return false;
      }
      await requestPickupAddress(ctx, city);
      return true;
    }
    case 'collectingDropoff': {
      const city = resolveDeliveryCity(ctx);
      if (!city || !draft.pickup) {
        return false;
      }
      await requestDropoffAddress(ctx, city, draft.pickup);
      return true;
    }
    case 'selectingAddressType':
      await requestAddressType(ctx, draft);
      return true;
    case 'collectingApartment':
      await requestApartment(ctx, draft);
      return true;
    case 'collectingEntrance':
      await requestEntrance(ctx, draft);
      return true;
    case 'collectingFloor':
      await requestFloor(ctx, draft);
      return true;
    case 'collectingRecipientPhone':
      await requestRecipientPhone(ctx, draft);
      return true;
    case 'collectingComment':
      await requestDeliveryComment(ctx, draft);
      return true;
    case 'awaitingConfirmation':
      if (isOrderDraftComplete(draft)) {
        await showConfirmation(ctx, draft as CompletedOrderDraft);
        return true;
      }
      return false;
    default:
      return false;
  }
};

registerFlowRecovery('client:delivery:step', async (ctx) => resumeDeliveryFlowStep(ctx));

registerFlowRecovery('client:delivery:status', async (ctx, payload) => {
  const details =
    payload && typeof payload === 'object'
      ? (payload as { emoji?: unknown; label?: unknown })
      : {};
  const emoji = typeof details.emoji === 'string' ? details.emoji : '⏳';
  const label =
    typeof details.label === 'string' ? details.label : 'Заказ отправлен исполнителям. Ожидаем отклика.';

  const { text, reply_markup } = buildStatusMessage(
    emoji,
    label,
    CLIENT_ORDERS_ACTION,
    CLIENT_MENU_ACTION,
  );

  await ui.step(ctx, {
    id: DELIVERY_STATUS_STEP_ID,
    text,
    keyboard: reply_markup,
    cleanup: true,
    homeAction: CLIENT_MENU_ACTION,
    recovery: { type: 'client:delivery:status', payload: { emoji, label } },
  });

  return true;
});

const handleStart = async (ctx: BotContext): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, undefined, 'Оформление заказа доступно только в личном чате с ботом.'))) {
    return;
  }

  const city = await ensureCitySelected(ctx, 'Выберите город, чтобы оформить доставку.');
  if (!city) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Сначала выберите город.');
    }
    return;
  }

  const draft = getDraft(ctx);
  resetClientOrderDraft(draft);
  draft.stage = 'collectingPickup';
  resetClientOrderDraft(ctx.session.client.taxi);

  await logClientMenuClick(ctx, 'client_home_menu:delivery');
  flowStart('delivery_order');

  await requestPickupAddress(ctx, city);
};

const handleConfirmationAction = async (ctx: BotContext): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, undefined, 'Подтвердите заказ в личном чате с ботом.'))) {
    return;
  }

  const draft = getDraft(ctx);
  await confirmOrder(ctx, draft);
};

const createAddressTypeActionHandler = (isPrivateHouse: boolean) =>
  async (ctx: BotContext): Promise<void> => {
    if (
      !(await ensurePrivateCallback(
        ctx,
        undefined,
        'Выбирайте тип адреса доставки в личном чате с ботом.',
      ))
    ) {
      return;
    }

    const draft = getDraft(ctx);
    if (draft.stage !== 'selectingAddressType') {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Тип адреса уже выбран.');
      }
      return;
    }

    await applyAddressTypeSelection(ctx, draft, isPrivateHouse);
  };

const handlePrivateHouseAddressType = createAddressTypeActionHandler(true);
const handleApartmentAddressType = createAddressTypeActionHandler(false);

const handleCancellationAction = async (ctx: BotContext): Promise<void> => {
  if (!(await ensurePrivateCallback(ctx, 'Оформление отменено.', 'Отмените заказ в личном чате с ботом.'))) {
    return;
  }

  const draft = getDraft(ctx);
  await cancelOrderDraft(ctx, draft);
};

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
      'Failed to resolve recent delivery pickup location; falling back to manual input',
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
      'Failed to resolve recent delivery dropoff location; falling back to manual input',
    );
  }
  if (!location) {
    await ctx.answerCbQuery(copy.expiredButton);
    return;
  }

  await applyDropoffDetails(ctx, draft, location);
  await ctx.answerCbQuery('Адрес подставлен.');
};

export const startDeliveryOrder = handleStart;

export const registerDeliveryOrderFlow = (bot: Telegraf<BotContext>): void => {
  bot.action(START_DELIVERY_ORDER_ACTION, async (ctx) => {
    await handleStart(ctx);
  });

  bot.action(CONFIRM_DELIVERY_ORDER_ACTION, async (ctx) => {
    await handleConfirmationAction(ctx);
  });

  bot.action(CANCEL_DELIVERY_ORDER_ACTION, async (ctx) => {
    await handleCancellationAction(ctx);
  });

  bot.action(DELIVERY_ADDRESS_TYPE_PRIVATE_ACTION, async (ctx) => {
    await handlePrivateHouseAddressType(ctx);
  });

  bot.action(DELIVERY_ADDRESS_TYPE_APARTMENT_ACTION, async (ctx) => {
    await handleApartmentAddressType(ctx);
  });

  bot.action(CLIENT_DELIVERY_ORDER_AGAIN_ACTION, async (ctx) => {
    await handleStart(ctx);
  });

  bot.action(DELIVERY_RECENT_PICKUP_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const encodedId = match?.[1];
    const locationId = encodedId ? decodeRecentLocationId(encodedId) : null;
    if (!locationId) {
      await ctx.answerCbQuery(copy.expiredButton);
      return;
    }

    await handleRecentPickup(ctx, locationId);
  });

  bot.action(DELIVERY_RECENT_DROPOFF_ACTION_PATTERN, async (ctx) => {
    const match = ctx.match as RegExpMatchArray | undefined;
    const encodedId = match?.[1];
    const locationId = encodedId ? decodeRecentLocationId(encodedId) : null;
    if (!locationId) {
      await ctx.answerCbQuery(copy.expiredButton);
      return;
    }

    await handleRecentDropoff(ctx, locationId);
  });

  bot.hears(CLIENT_MENU.delivery, async (ctx) => {
    if (!isClientChat(ctx, ctx.auth?.user.role)) {
      return;
    }

    await handleStart(ctx);
  });

  bot.command('delivery', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }

    const city = await ensureCitySelected(ctx, 'Выберите город, чтобы оформить доставку.');
    if (!city) {
      return;
    }

    const draft = getDraft(ctx);
    resetClientOrderDraft(draft);
    draft.stage = 'collectingPickup';
    resetClientOrderDraft(ctx.session.client.taxi);

    await requestPickupAddress(ctx, city);
  });

  bot.on('location', async (ctx, next) => {
    await handleIncomingLocation(ctx, next);
  });

  bot.on('text', async (ctx, next) => {
    await handleIncomingText(ctx, next);
  });
};
