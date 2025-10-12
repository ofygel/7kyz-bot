import express from 'express';
import type { Express, Request, Response } from 'express';

import { app } from '../app';
import { config, logger } from '../config';
import {
  createOrder,
  getOrderWithExecutorById,
  markOrderAsCancelled,
} from '../db/orders';
import {
  publishOrderToDriversChannel,
  handleClientOrderCancellation,
  type PublishOrderStatus,
} from '../bot/channels/ordersChannel';
import { subscribeToOrder, type OrderEventPayload } from '../services/orderEvents';
import { isAppCity } from '../domain/cities';
import {
  estimateDeliveryPrice,
  estimateTaxiPrice,
} from '../services/pricing';
import type {
  OrderInsertInput,
  OrderKind,
  OrderLocation,
  OrderPriceDetails,
  OrderRecord,
  OrderWithExecutor,
} from '../types';

const SPA_API_KEY_HEADER = 'x-spa-api-key';

type ApiErrorResponse = {
  error: string;
  details?: string[];
};

type CreateOrderResponse = {
  order: ApiOrder;
  publishStatus: PublishOrderStatus | 'publish_failed';
};

type OrderResponse = {
  order: ApiOrder;
};

type CancelOrderResponse = {
  order: ApiOrder;
  updated: boolean;
};

type StreamEventPayload = {
  type: OrderEventPayload['type'] | 'snapshot' | 'not_found';
  order?: ApiOrder;
};

interface ApiOrderExecutor {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

interface ApiOrder extends Omit<OrderRecord, 'createdAt' | 'updatedAt' | 'claimedAt' | 'completedAt'> {
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  executor?: ApiOrderExecutor;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const parseOptionalString = (value: unknown): string | undefined =>
  isNonEmptyString(value) ? value.trim() : undefined;

const parseOptionalNumber = (
  value: unknown,
  label: string,
  errors: string[],
): number | undefined => {
  if (typeof value === 'undefined' || value === null) {
    return undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  errors.push(`${label} must be a number`);
  return undefined;
};

const parseOptionalFloat = (
  value: unknown,
  label: string,
  errors: string[],
): number | undefined => {
  if (typeof value === 'undefined' || value === null) {
    return undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  errors.push(`${label} must be a number`);
  return undefined;
};

const parseOptionalBoolean = (
  value: unknown,
  label: string,
  errors: string[],
): boolean | undefined => {
  if (typeof value === 'undefined' || value === null) {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(trimmed)) {
      return true;
    }
    if (['false', '0', 'no'].includes(trimmed)) {
      return false;
    }
  }

  errors.push(`${label} must be a boolean`);
  return undefined;
};

const parseLocation = (
  value: unknown,
  label: string,
  errors: string[],
): OrderLocation | null => {
  if (!value || typeof value !== 'object') {
    errors.push(`${label} must be an object`);
    return null;
  }

  const location = value as Record<string, unknown>;
  const query = parseOptionalString(location.query);
  const address = parseOptionalString(location.address);
  const lat = parseOptionalFloat(location.latitude ?? location.lat, `${label}.latitude`, errors);
  const lon = parseOptionalFloat(location.longitude ?? location.lon, `${label}.longitude`, errors);
  const twoGis = parseOptionalString(location.twoGisUrl ?? location['2gisUrl']);

  if (!query) {
    errors.push(`${label}.query is required`);
  }

  if (!address) {
    errors.push(`${label}.address is required`);
  }

  if (typeof lat !== 'number' || !Number.isFinite(lat)) {
    errors.push(`${label}.latitude is required`);
  }

  if (typeof lon !== 'number' || !Number.isFinite(lon)) {
    errors.push(`${label}.longitude is required`);
  }

  if (!query || !address || typeof lat !== 'number' || typeof lon !== 'number') {
    return null;
  }

  return {
    query,
    address,
    latitude: lat,
    longitude: lon,
    twoGisUrl: twoGis,
  } satisfies OrderLocation;
};

const buildPriceDetails = (
  raw: unknown,
  kind: OrderKind,
  pickup: OrderLocation,
  dropoff: OrderLocation,
  errors: string[],
): OrderPriceDetails => {
  const fallback =
    kind === 'delivery'
      ? estimateDeliveryPrice(pickup, dropoff)
      : estimateTaxiPrice(pickup, dropoff);

  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const candidate = raw as Record<string, unknown>;
  const amount = parseOptionalFloat(candidate.amount, 'price.amount', errors) ?? fallback.amount;
  const currency = parseOptionalString(candidate.currency) ?? fallback.currency;
  const distance = parseOptionalFloat(
    candidate.distanceKm ?? candidate.distance,
    'price.distanceKm',
    errors,
  );
  const eta = parseOptionalNumber(candidate.etaMinutes ?? candidate.eta, 'price.etaMinutes', errors);

  return {
    amount,
    currency,
    distanceKm: distance ?? fallback.distanceKm,
    etaMinutes: eta ?? fallback.etaMinutes,
  } satisfies OrderPriceDetails;
};

const hasExecutor = (order: OrderRecord | OrderWithExecutor): order is OrderWithExecutor =>
  Boolean((order as OrderWithExecutor).executor);

const serializeOrder = (order: OrderRecord | OrderWithExecutor): ApiOrder => {
  const executor = hasExecutor(order) ? order.executor : undefined;

  return {
    id: order.id,
    shortId: order.shortId,
    kind: order.kind,
    status: order.status,
    city: order.city,
    clientId: order.clientId,
    clientPhone: order.clientPhone,
    recipientPhone: order.recipientPhone,
    customerName: order.customerName,
    customerUsername: order.customerUsername,
    clientComment: order.clientComment,
    apartment: order.apartment,
    entrance: order.entrance,
    floor: order.floor,
    isPrivateHouse: order.isPrivateHouse,
    claimedBy: order.claimedBy,
    claimedAt: order.claimedAt?.toISOString(),
    completedAt: order.completedAt?.toISOString(),
    pickup: order.pickup,
    dropoff: order.dropoff,
    price: order.price,
    channelMessageId: order.channelMessageId,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    executor: executor
      ? {
          telegramId: executor.telegramId,
          username: executor.username,
          firstName: executor.firstName,
          lastName: executor.lastName,
          phone: executor.phone,
        }
      : undefined,
  } satisfies ApiOrder;
};

const parseCreateOrderPayload = (body: unknown): { input?: OrderInsertInput; errors: string[] } => {
  const errors: string[] = [];

  if (!body || typeof body !== 'object') {
    return { errors: ['Request body must be a JSON object'] };
  }

  const payload = body as Record<string, unknown>;
  const kindRaw = payload.kind;
  if (kindRaw !== 'delivery' && kindRaw !== 'taxi') {
    errors.push('kind must be either "delivery" or "taxi"');
  }

  const kind = kindRaw === 'delivery' || kindRaw === 'taxi' ? (kindRaw as OrderKind) : undefined;

  const cityCandidate = payload.city;
  const city = isAppCity(cityCandidate) ? cityCandidate : undefined;
  if (!city) {
    errors.push('city must be a supported city code');
  }

  const pickup = parseLocation(payload.pickup, 'pickup', errors);
  const dropoff = parseLocation(payload.dropoff, 'dropoff', errors);

  const client = payload.client;
  let clientId: number | undefined;
  let clientPhone: string | undefined;
  let customerName: string | undefined;
  let customerUsername: string | undefined;

  if (typeof client === 'object' && client !== null) {
    const clientRecord = client as Record<string, unknown>;
    clientId = parseOptionalNumber(clientRecord.id, 'client.id', errors);
    clientPhone = parseOptionalString(clientRecord.phone);
    customerName = parseOptionalString(clientRecord.name ?? clientRecord.fullName);
    customerUsername = parseOptionalString(clientRecord.username);
  } else if (typeof client !== 'undefined' && client !== null) {
    errors.push('client must be an object when provided');
  }

  clientId = parseOptionalNumber(payload.clientId, 'clientId', errors) ?? clientId;
  clientPhone = parseOptionalString(payload.clientPhone) ?? clientPhone;
  customerName = parseOptionalString(payload.customerName) ?? customerName;
  customerUsername = parseOptionalString(payload.customerUsername) ?? customerUsername;

  const recipientPhone = parseOptionalString(payload.recipientPhone ?? payload.recipient_phone);
  if (!recipientPhone) {
    errors.push('recipientPhone is required');
  }

  const comment =
    parseOptionalString(payload.comment) ??
    parseOptionalString(payload.clientComment ?? payload.notes);

  let apartment: string | undefined;
  let entrance: string | undefined;
  let floor: string | undefined;
  let isPrivateHouse: boolean | undefined;

  if (payload.dropoff && typeof payload.dropoff === 'object') {
    const dropoffRecord = payload.dropoff as Record<string, unknown>;
    apartment = parseOptionalString(dropoffRecord.apartment ?? dropoffRecord.flat);
    entrance = parseOptionalString(dropoffRecord.entrance ?? dropoffRecord.entranceNumber);
    floor = parseOptionalString(dropoffRecord.floor);
    isPrivateHouse = parseOptionalBoolean(
      dropoffRecord.isPrivateHouse ?? dropoffRecord.privateHouse,
      'dropoff.isPrivateHouse',
      errors,
    );
  }

  if (!kind || !pickup || !dropoff || !city || !recipientPhone) {
    return { errors };
  }

  const price = buildPriceDetails(payload.price, kind, pickup, dropoff, errors);

  if (errors.length > 0) {
    return { errors };
  }

  const input: OrderInsertInput = {
    kind,
    city,
    clientId,
    clientPhone,
    recipientPhone,
    customerName,
    customerUsername,
    clientComment: comment,
    apartment,
    entrance,
    floor,
    isPrivateHouse,
    pickup,
    dropoff,
    price,
  };

  return { input, errors };
};

const ensureApiKey = (req: Request, res: Response): boolean => {
  const { apiKeys } = config.spa;
  if (apiKeys.length === 0) {
    return true;
  }

  const provided = req.header(SPA_API_KEY_HEADER)?.trim();
  if (!provided || !apiKeys.includes(provided)) {
    res.status(401).json({ error: 'invalid_api_key' } satisfies ApiErrorResponse);
    return false;
  }

  return true;
};

const sendSseEvent = (res: Response, event: string, data: StreamEventPayload): void => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const parseOrderId = (value: string, res: Response): number | null => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    res.status(400).json({ error: 'invalid_order_id' } satisfies ApiErrorResponse);
    return null;
  }

  return parsed;
};

const fetchOrderForResponse = async (orderId: number): Promise<OrderWithExecutor | null> =>
  await getOrderWithExecutorById(orderId);

const respondWithOrder = async (res: Response, orderId: number, status = 200): Promise<void> => {
  const order = await fetchOrderForResponse(orderId);
  if (!order) {
    res.status(404).json({ error: 'not_found' } satisfies ApiErrorResponse);
    return;
  }

  res.status(status).json({ order: serializeOrder(order) } satisfies OrderResponse);
};

export const registerSpaOrderRoutes = (expressApp: Express): void => {
  const router = express.Router();

  router.post('/orders', async (req: Request, res: Response): Promise<void> => {
    if (!ensureApiKey(req, res)) {
      return;
    }

    const { input, errors } = parseCreateOrderPayload(req.body);
    if (!input || errors.length > 0) {
      res
        .status(400)
        .json({ error: 'validation_error', details: errors } satisfies ApiErrorResponse);
      return;
    }

    let order: OrderRecord;
    try {
      order = await createOrder(input);
    } catch (error) {
      logger.error({ err: error }, 'Failed to create order from SPA payload');
      res.status(500).json({ error: 'order_creation_failed' } satisfies ApiErrorResponse);
      return;
    }

    let publishStatus: PublishOrderStatus | 'publish_failed';

    try {
      const publishResult = await publishOrderToDriversChannel(app.telegram, order.id);
      publishStatus = publishResult.status;
    } catch (error) {
      logger.error({ err: error, orderId: order.id }, 'Failed to publish SPA order');
      publishStatus = 'publish_failed';

      try {
        const cancelled = await markOrderAsCancelled(order.id);
        if (cancelled) {
          order = cancelled;
        }
      } catch (cancelError) {
        logger.error(
          { err: cancelError, orderId: order.id },
          'Failed to cancel SPA order after publish failure',
        );
      }
    }

    const detailed = await fetchOrderForResponse(order.id);
    const responseOrder = detailed ?? order;

    res
      .status(201)
      .json({ order: serializeOrder(responseOrder), publishStatus } satisfies CreateOrderResponse);
  });

  router.get('/orders/:id', async (req: Request, res: Response): Promise<void> => {
    if (!ensureApiKey(req, res)) {
      return;
    }

    const orderId = parseOrderId(req.params.id, res);
    if (!orderId) {
      return;
    }

    await respondWithOrder(res, orderId);
  });

  router.post('/orders/:id/cancel', async (req: Request, res: Response): Promise<void> => {
    if (!ensureApiKey(req, res)) {
      return;
    }

    const orderId = parseOrderId(req.params.id, res);
    if (!orderId) {
      return;
    }

    const existing = await fetchOrderForResponse(orderId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' } satisfies ApiErrorResponse);
      return;
    }

    if (['cancelled', 'finished', 'expired'].includes(existing.status)) {
      res.status(200).json({ order: serializeOrder(existing), updated: false } satisfies CancelOrderResponse);
      return;
    }

    let cancelled: OrderRecord | null = null;
    try {
      cancelled = await markOrderAsCancelled(orderId);
    } catch (error) {
      logger.error({ err: error, orderId }, 'Failed to cancel order from SPA');
      res.status(500).json({ error: 'order_cancel_failed' } satisfies ApiErrorResponse);
      return;
    }

    const finalState = await fetchOrderForResponse(orderId);
    if (!finalState) {
      res.status(404).json({ error: 'not_found' } satisfies ApiErrorResponse);
      return;
    }

    if (finalState.status === 'cancelled') {
      try {
        await handleClientOrderCancellation(app.telegram, finalState);
      } catch (error) {
        logger.error(
          { err: error, orderId },
          'Failed to propagate cancellation to Telegram after SPA request',
        );
      }
    }

    res
      .status(200)
      .json({ order: serializeOrder(finalState), updated: Boolean(cancelled) } satisfies CancelOrderResponse);
  });

  router.get('/orders/:id/stream', async (req: Request, res: Response): Promise<void> => {
    if (!ensureApiKey(req, res)) {
      return;
    }

    const orderId = parseOrderId(req.params.id, res);
    if (!orderId) {
      return;
    }

    const initialOrder = await fetchOrderForResponse(orderId);
    if (!initialOrder) {
      res.status(404).json({ error: 'not_found' } satisfies ApiErrorResponse);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const flushable = res as Response & { flushHeaders?: () => void };
    flushable.flushHeaders?.();

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        return;
      }
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, config.spa.streamHeartbeatMs);

    sendSseEvent(res, 'snapshot', {
      type: 'snapshot',
      order: serializeOrder(initialOrder),
    });

    const unsubscribe = subscribeToOrder(orderId, (payload) => {
      void (async () => {
        if (res.writableEnded) {
          return;
        }

        let orderForEvent: OrderRecord | OrderWithExecutor = payload.order;
        try {
          const detailed = await fetchOrderForResponse(orderId);
          if (detailed) {
            orderForEvent = detailed;
          }
        } catch (error) {
          logger.warn({ err: error, orderId }, 'Failed to refresh order snapshot for SSE');
        }

        if (res.writableEnded) {
          return;
        }

        sendSseEvent(res, payload.type, {
          type: payload.type,
          order: serializeOrder(orderForEvent),
        });
      })();
    });

    const closeConnection = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', closeConnection);
    req.on('error', closeConnection);
  });

  expressApp.use('/api/spa', router);
};
