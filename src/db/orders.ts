import type { PoolClient } from './client';
import { pool } from './client';
import { logger } from '../config';
import { activeOrdersGauge } from '../metrics/business';
import { updateUserSubscriptionStatus } from './users';
import { emitOrderEvent, emitStatusEvent } from '../services/orderEvents';

import type {
  OrderInsertInput,
  OrderKind,
  OrderLocation,
  OrderPriceDetails,
  OrderRecord,
  OrderStatus,
  OrderWithExecutor,
} from '../types';
import { isAppCity } from '../domain/cities';
import type { AppCity } from '../domain/cities';
import { estimateEtaMinutes } from '../services/pricing';

interface OrderRow {
  id: number;
  short_id: string;
  kind: OrderKind;
  status: string;
  city: string | null;
  client_id: string | number | null;
  client_phone: string | null;
  recipient_phone: string | null;
  customer_name: string | null;
  customer_username: string | null;
  client_comment: string | null;
  claimed_by: string | number | null;
  claimed_at: Date | string | null;
  completed_at: Date | string | null;
  pickup_query: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lon: number;
  pickup_2gis_url: string | null;
  dropoff_query: string;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lon: number;
  dropoff_2gis_url: string | null;
  dropoff_apartment: string | null;
  dropoff_entrance: string | null;
  dropoff_floor: string | null;
  is_private_house: boolean | null;
  price_amount: number;
  price_currency: string;
  distance_km: number | string;
  channel_message_id: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OrderWithExecutorRow extends OrderRow {
  executor_tg_id: string | number | null;
  executor_username: string | null;
  executor_first_name: string | null;
  executor_last_name: string | null;
  executor_phone: string | null;
}

const parseNumeric = (value: string | number | null | undefined): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const mapLocation = (
  query: string,
  address: string,
  lat: number,
  lon: number,
  twoGisUrl: string | null,
): OrderLocation => ({
  query,
  address,
  latitude: lat,
  longitude: lon,
  twoGisUrl: twoGisUrl ?? undefined,
});

const mapPrice = (amount: number, currency: string, distance: number | string): OrderPriceDetails => {
  const parsed =
    typeof distance === 'string' ? Number.parseFloat(distance) : distance;
  const distanceKm = Number.isNaN(parsed) ? 0 : parsed;

  return {
    amount,
    currency,
    distanceKm,
    etaMinutes: estimateEtaMinutes(distanceKm),
  } satisfies OrderPriceDetails;
};

const mapOrderRow = (row: OrderRow): OrderRecord => {
  const city: AppCity = isAppCity(row.city) ? row.city : 'almaty';

  return {
    id: row.id,
    shortId: row.short_id,
    kind: row.kind,
    status: row.status as OrderRecord['status'],
    city,
    clientId: parseNumeric(row.client_id),
    clientPhone: row.client_phone ?? undefined,
    recipientPhone: row.recipient_phone ?? undefined,
    customerName: row.customer_name ?? undefined,
    customerUsername: row.customer_username ?? undefined,
    clientComment: row.client_comment ?? undefined,
    apartment: row.dropoff_apartment ?? undefined,
    entrance: row.dropoff_entrance ?? undefined,
    floor: row.dropoff_floor ?? undefined,
    isPrivateHouse: row.is_private_house ?? undefined,
    claimedBy: parseNumeric(row.claimed_by),
    claimedAt:
      row.claimed_at instanceof Date
        ? row.claimed_at
        : row.claimed_at
        ? new Date(row.claimed_at)
        : undefined,
    completedAt:
      row.completed_at instanceof Date
        ? row.completed_at
        : row.completed_at
        ? new Date(row.completed_at)
        : undefined,
    pickup: mapLocation(
      row.pickup_query,
      row.pickup_address,
      row.pickup_lat,
      row.pickup_lon,
      row.pickup_2gis_url,
    ),
    dropoff: mapLocation(
      row.dropoff_query,
      row.dropoff_address,
      row.dropoff_lat,
      row.dropoff_lon,
      row.dropoff_2gis_url,
    ),
    price: mapPrice(row.price_amount, row.price_currency, row.distance_km),
    channelMessageId: parseNumeric(row.channel_message_id),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  } satisfies OrderRecord;
};

const mapOrderWithExecutorRow = (row: OrderWithExecutorRow): OrderWithExecutor => {
  const order = mapOrderRow(row);
  const executorId = parseNumeric(row.executor_tg_id);

  if (!executorId) {
    return { ...order } satisfies OrderWithExecutor;
  }

  return {
    ...order,
    executor: {
      telegramId: executorId,
      username: row.executor_username ?? undefined,
      firstName: row.executor_first_name ?? undefined,
      lastName: row.executor_last_name ?? undefined,
      phone: row.executor_phone ?? undefined,
    },
  } satisfies OrderWithExecutor;
};

const notifyOrderCreated = (order: OrderRecord): void => {
  emitOrderEvent({ type: 'created', order });
};

const notifyOrderUpdated = (order: OrderRecord): void => {
  emitStatusEvent(order);
};

const updateActiveOrdersGauge = async (queryable: Pick<PoolClient, 'query'>): Promise<void> => {
  try {
    const { rows } = await queryable.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM orders WHERE status IN ('open', 'claimed', 'in_progress')",
    );
    const [row] = rows;
    if (row && typeof row.count === 'number') {
      activeOrdersGauge.set(row.count);
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to update active orders gauge');
  }
};

const updateExecutorHasActiveOrder = async (
  client: PoolClient,
  executorId: number | null | undefined,
): Promise<boolean> => {
  if (typeof executorId !== 'number') {
    return false;
  }

  const { rows } = await client.query<{ has_active_order: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM orders
        WHERE claimed_by = $1
          AND status IN ('open', 'claimed', 'in_progress')
      ) AS has_active_order
    `,
    [executorId],
  );

  const hasActiveOrder = Boolean(rows[0]?.has_active_order);

  await updateUserSubscriptionStatus({
    client,
    telegramId: executorId,
    hasActiveOrder,
  });

  return hasActiveOrder;
};

export const createOrder = async (input: OrderInsertInput): Promise<OrderRecord> => {
  const { rows } = await pool.query<OrderRow>(
    `
      INSERT INTO orders (
        short_id,
        kind,
        status,
        client_id,
        client_phone,
        recipient_phone,
        customer_name,
        customer_username,
        client_comment,
        pickup_query,
        pickup_address,
        pickup_lat,
        pickup_lon,
        pickup_2gis_url,
        dropoff_query,
        dropoff_address,
        dropoff_lat,
        dropoff_lon,
        dropoff_2gis_url,
        dropoff_apartment,
        dropoff_entrance,
        dropoff_floor,
        is_private_house,
        city,
        price_amount,
        price_currency,
        distance_km,
        claimed_by,
        claimed_at,
        completed_at
      )
      VALUES (
        DEFAULT,
        $1,
        'new',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21,
        $22,
        $23,
        $24,
        $25,
        NULL,
        NULL,
        NULL
      )
      RETURNING *
    `,
    [
      input.kind,
      input.clientId ?? null,
      input.clientPhone ?? null,
      input.recipientPhone ?? null,
      input.customerName ?? null,
      input.customerUsername ?? null,
      input.clientComment ?? null,
      input.pickup.query,
      input.pickup.address,
      input.pickup.latitude,
      input.pickup.longitude,
      input.pickup.twoGisUrl ?? null,
      input.dropoff.query,
      input.dropoff.address,
      input.dropoff.latitude,
      input.dropoff.longitude,
      input.dropoff.twoGisUrl ?? null,
      input.apartment ?? null,
      input.entrance ?? null,
      input.floor ?? null,
      input.isPrivateHouse ?? null,
      input.city,
      input.price.amount,
      input.price.currency,
      input.price.distanceKm,
    ],
  );

  const [row] = rows;
  if (!row) {
    throw new Error('Failed to insert order');
  }

  await updateActiveOrdersGauge(pool);

  const order = mapOrderRow(row);
  notifyOrderCreated(order);
  return order;
};

export const getOrderById = async (id: number): Promise<OrderRecord | null> => {
  const { rows } = await pool.query<OrderRow>(
    `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
    [id],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const lockOrderById = async (
  client: PoolClient,
  id: number,
  options: { skipLocked?: boolean } = {},
): Promise<OrderRecord | null> => {
  const lockingClause = options.skipLocked ? 'FOR UPDATE SKIP LOCKED' : 'FOR UPDATE';
  const { rows } = await client.query<OrderRow>(
    `SELECT * FROM orders WHERE id = $1 ${lockingClause}`,
    [id],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const setOrderChannelMessageId = async (
  client: PoolClient,
  id: number,
  messageId: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `UPDATE orders SET channel_message_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, messageId],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const markOrderAsOpen = async (
  client: PoolClient,
  id: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'open',
          updated_at = now()
      WHERE id = $1 AND status = 'new'
      RETURNING *
    `,
    [id],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const tryClaimOrder = async (
  client: PoolClient,
  id: number,
  claimedBy: number,
  city: AppCity,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'claimed',
          claimed_by = $2,
          claimed_at = now(),
          updated_at = now()
      WHERE id = $1 AND status = 'open' AND city = $3
      RETURNING *
    `,
    [id, claimedBy, city],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  await updateExecutorHasActiveOrder(client, claimedBy);
  await updateActiveOrdersGauge(client);
  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const tryReleaseOrder = async (
  client: PoolClient,
  id: number,
  claimedBy: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'open',
          claimed_by = NULL,
          claimed_at = NULL,
          channel_message_id = NULL,
          updated_at = now()
      WHERE id = $1 AND status = ANY('{claimed,in_progress}'::order_status[]) AND claimed_by = $2
      RETURNING *
    `,
    [id, claimedBy],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  await updateExecutorHasActiveOrder(client, claimedBy);
  await updateActiveOrdersGauge(client);
  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const tryReclaimOrder = async (
  client: PoolClient,
  id: number,
  executorId: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'claimed',
          claimed_by = $2,
          claimed_at = now(),
          channel_message_id = NULL,
          updated_at = now()
      WHERE id = $1 AND status = 'open' AND claimed_by IS NULL
      RETURNING *
    `,
    [id, executorId],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  await updateExecutorHasActiveOrder(client, executorId);
  await updateActiveOrdersGauge(client);
  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const tryCompleteOrder = async (
  client: PoolClient,
  id: number,
  claimedBy: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'finished',
          completed_at = now(),
          updated_at = now()
      WHERE id = $1 AND status = ANY('{claimed,in_progress}'::order_status[]) AND claimed_by = $2
      RETURNING *
    `,
    [id, claimedBy],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  await updateExecutorHasActiveOrder(client, claimedBy);
  await updateActiveOrdersGauge(client);
  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

const tryMarkOrderInProgress = async (
  client: PoolClient,
  id: number,
  claimedBy: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'in_progress',
          completed_at = NULL,
          updated_at = now()
      WHERE id = $1 AND status = 'claimed' AND claimed_by = $2
      RETURNING *
    `,
    [id, claimedBy],
  );

  const [row] = rows;
  return row ? mapOrderRow(row) : null;
};

export type ExecutorCompletionTransition = 'started' | 'finished';

export interface ExecutorCompletionResult {
  order: OrderRecord;
  transition: ExecutorCompletionTransition;
}

export const tryRestoreCompletedOrder = async (
  client: PoolClient,
  id: number,
  executorId: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'claimed',
          completed_at = NULL,
          updated_at = now()
      WHERE id = $1 AND status = 'finished' AND claimed_by = $2
      RETURNING *
    `,
    [id, executorId],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  await updateExecutorHasActiveOrder(client, executorId);
  await updateActiveOrdersGauge(client);
  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const tryCancelOrder = async (
  client: PoolClient,
  id: number,
): Promise<OrderRecord | null> => {
  const { rows } = await client.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'cancelled',
          updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING *
    `,
    [id],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  await updateActiveOrdersGauge(client);
  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const markOrderAsCancelled = async (orderId: number): Promise<OrderRecord | null> => {
  const { rows } = await pool.query<OrderRow>(
    `
      UPDATE orders
      SET status = 'cancelled',
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [orderId],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  await updateActiveOrdersGauge(pool);
  const order = mapOrderRow(row);
  notifyOrderUpdated(order);
  return order;
};

export interface ListOpenOrdersOptions {
  city: AppCity;
  limit?: number;
}

export const listOpenOrdersByCity = async ({
  city,
  limit,
}: ListOpenOrdersOptions): Promise<OrderRecord[]> => {
  const params: unknown[] = [city];
  let limitClause = '';

  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    params.push(Math.trunc(limit));
    limitClause = `LIMIT $${params.length}::int`;
  }

  const { rows } = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE status = 'open'
        AND city = $1
      ORDER BY created_at DESC, id DESC
      ${limitClause}
    `,
    params,
  );

  return rows.map(mapOrderRow);
};

export const findActiveOrderForExecutor = async (
  executorId: number,
): Promise<OrderRecord | null> => {
  const { rows } = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE claimed_by = $1
        AND status = ANY('{claimed,in_progress}'::order_status[])
      ORDER BY updated_at DESC, claimed_at DESC NULLS LAST, id DESC
      LIMIT 1
    `,
    [executorId],
  );

  const [row] = rows;
  return row ? mapOrderRow(row) : null;
};

export const listExecutorOrders = async (
  executorId: number,
  statuses: OrderStatus[] = ['claimed', 'in_progress'],
  limit = 20,
): Promise<OrderRecord[]> => {
  const statusFilter = statuses.length > 0 ? statuses : ['claimed', 'in_progress'];
  const params: unknown[] = [executorId, statusFilter];
  if (limit && Number.isFinite(limit) && limit > 0) {
    params.push(Math.trunc(limit));
  }

  const limitClause = params.length === 3 ? 'LIMIT $3::int' : '';

  const { rows } = await pool.query<OrderRow>(
    `
      SELECT *
      FROM orders
      WHERE claimed_by = $1
        AND status = ANY($2::order_status[])
      ORDER BY updated_at DESC, id DESC
      ${limitClause}
    `,
    params,
  );

  return rows.map(mapOrderRow);
};

export const completeOrderByExecutor = async (
  orderId: number,
  executorId: number,
): Promise<ExecutorCompletionResult | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await lockOrderById(client, orderId);

    if (
      !current ||
      current.claimedBy !== executorId ||
      (current.status !== 'claimed' && current.status !== 'in_progress')
    ) {
      await client.query('ROLLBACK');
      return null;
    }

    let updated: OrderRecord | null = null;
    let transition: ExecutorCompletionTransition = 'started';

    if (current.status === 'claimed') {
      updated = await tryMarkOrderInProgress(client, orderId, executorId);
      if (updated) {
        await updateExecutorHasActiveOrder(client, executorId);
        await updateActiveOrdersGauge(client);
      }
    } else {
      transition = 'finished';
      updated = await tryCompleteOrder(client, orderId, executorId);
    }

    if (!updated) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('COMMIT');
    return { order: updated, transition };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'Failed to roll back executor order completion');
    }
    throw error;
  } finally {
    client.release();
  }
};

export interface ExpireOrdersOptions {
  olderThanHours?: number;
  statuses?: OrderStatus[];
}

export interface ExpireOrdersResult {
  expired: number;
  affectedExecutors: number[];
}

export const expireStaleOrders = async (
  options: ExpireOrdersOptions = {},
): Promise<ExpireOrdersResult> => {
  const olderThanHours = Math.max(1, Math.floor(options.olderThanHours ?? 6));
  const statuses = (options.statuses && options.statuses.length > 0
    ? options.statuses
    : ['open', 'claimed', 'in_progress']) satisfies OrderStatus[];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OrderRow>(
      `
        UPDATE orders
        SET status = 'expired',
            updated_at = now()
        WHERE status = ANY($1::order_status[])
          AND updated_at <= now() - ($2::int * INTERVAL '1 hour')
        RETURNING *
          AND (
            (
              status = 'in_progress'
              AND claimed_at IS NOT NULL
              AND claimed_at <= now() - ($2::int * INTERVAL '1 hour')
            )
            OR (
              status <> 'in_progress'
              AND COALESCE(claimed_at, updated_at) <= now() - ($2::int * INTERVAL '1 hour')
            )
          )
      RETURNING id, claimed_by
      `,
      [statuses, olderThanHours],
    );

    const affectedExecutors = new Set<number>();
    const expiredOrders: OrderRecord[] = [];
    for (const row of rows) {
      const order = mapOrderRow(row);
      expiredOrders.push(order);

      if (typeof row.claimed_by === 'number') {
        affectedExecutors.add(Number(row.claimed_by));
      }
    }

    for (const executorId of affectedExecutors) {
      await updateExecutorHasActiveOrder(client, executorId);
    }

    await updateActiveOrdersGauge(client);
    await client.query('COMMIT');

    for (const order of expiredOrders) {
      notifyOrderUpdated(order);
    }

    return { expired: rows.length, affectedExecutors: [...affectedExecutors] };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'Failed to roll back order expiration transaction');
    }
    throw error;
  } finally {
    client.release();
  }
};

export interface ListClientOrdersOptions {
  statuses?: OrderStatus[];
  limit?: number;
}

const buildClientOrdersQuery = (
  options: ListClientOrdersOptions,
): { whereClause: string; params: unknown[]; limitClause: string } => {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (options.statuses && options.statuses.length > 0) {
    params.push(options.statuses);
    conditions.push(`o.status = ANY($${params.length + 1}::order_status[])`);
  }

  const limit = options.limit && options.limit > 0 ? Math.trunc(options.limit) : undefined;
  const limitClause = limit ? `LIMIT $${params.length + 2}::int` : '';
  if (limit) {
    params.push(limit);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  return { whereClause, params, limitClause };
};

export const listClientOrders = async (
  clientId: number,
  options: ListClientOrdersOptions = {},
): Promise<OrderWithExecutor[]> => {
  const { whereClause, params, limitClause } = buildClientOrdersQuery(options);

  const queryParams: unknown[] = [clientId, ...params];

  const { rows } = await pool.query<OrderWithExecutorRow>(
    `
      SELECT
        o.*,
        e.tg_id AS executor_tg_id,
        e.username AS executor_username,
        e.first_name AS executor_first_name,
        e.last_name AS executor_last_name,
        e.phone AS executor_phone
      FROM orders o
      LEFT JOIN users e ON e.tg_id = o.claimed_by
      WHERE o.client_id = $1
        ${whereClause}
      ORDER BY o.created_at DESC, o.id DESC
      ${limitClause}
    `,
    queryParams,
  );

  return rows.map(mapOrderWithExecutorRow);
};

export const getOrderWithExecutorById = async (id: number): Promise<OrderWithExecutor | null> => {
  const { rows } = await pool.query<OrderWithExecutorRow>(
    `
      SELECT
        o.*,
        e.tg_id AS executor_tg_id,
        e.username AS executor_username,
        e.first_name AS executor_first_name,
        e.last_name AS executor_last_name,
        e.phone AS executor_phone
      FROM orders o
      LEFT JOIN users e ON e.tg_id = o.claimed_by
      WHERE o.id = $1
      LIMIT 1
    `,
    [id],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const order = mapOrderWithExecutorRow(row);
  notifyOrderUpdated(order);
  return order;
};

export const cancelClientOrder = async (
  orderId: number,
  clientId: number,
): Promise<OrderWithExecutor | null> => {
  const { rows } = await pool.query<OrderWithExecutorRow>(
    `
      UPDATE orders o
      SET status = 'cancelled',
          updated_at = now()
      WHERE o.id = $1
        AND o.client_id = $2
        AND o.status IN ('open', 'claimed')
      RETURNING
        o.*,
        (SELECT u.tg_id FROM users u WHERE u.tg_id = o.claimed_by) AS executor_tg_id,
        (SELECT u.username FROM users u WHERE u.tg_id = o.claimed_by) AS executor_username,
        (SELECT u.first_name FROM users u WHERE u.tg_id = o.claimed_by) AS executor_first_name,
        (SELECT u.last_name FROM users u WHERE u.tg_id = o.claimed_by) AS executor_last_name,
        (SELECT u.phone FROM users u WHERE u.tg_id = o.claimed_by) AS executor_phone
    `,
    [orderId, clientId],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const order = mapOrderWithExecutorRow(row);
  notifyOrderUpdated(order);
  return order;
};

