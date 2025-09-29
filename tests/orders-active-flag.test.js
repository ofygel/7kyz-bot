const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

ensureEnv('BOT_TOKEN', 'test-bot-token');
ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
ensureEnv('KASPI_NAME', 'Test User');
ensureEnv('KASPI_PHONE', '+70000000000');
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');

const {
  tryClaimOrder,
  tryReleaseOrder,
  tryCompleteOrder,
  tryRestoreCompletedOrder,
} = require('../src/db/orders');

const normalizeSql = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

const createOrderRow = (overrides = {}) => ({
  id: overrides.id ?? 1,
  short_id: overrides.short_id ?? 'T-1',
  kind: overrides.kind ?? 'delivery',
  status: overrides.status ?? 'open',
  city: overrides.city ?? 'almaty',
  client_id: overrides.client_id ?? null,
  client_phone: overrides.client_phone ?? null,
  recipient_phone: overrides.recipient_phone ?? null,
  customer_name: overrides.customer_name ?? null,
  customer_username: overrides.customer_username ?? null,
  client_comment: overrides.client_comment ?? null,
  claimed_by: overrides.claimed_by ?? null,
  claimed_at: overrides.claimed_at ?? null,
  completed_at: overrides.completed_at ?? null,
  pickup_query: overrides.pickup_query ?? 'pickup-query',
  pickup_address: overrides.pickup_address ?? 'Pickup address',
  pickup_lat: overrides.pickup_lat ?? 43.238949,
  pickup_lon: overrides.pickup_lon ?? 76.889709,
  pickup_2gis_url: overrides.pickup_2gis_url ?? null,
  dropoff_query: overrides.dropoff_query ?? 'dropoff-query',
  dropoff_address: overrides.dropoff_address ?? 'Dropoff address',
  dropoff_lat: overrides.dropoff_lat ?? 43.25654,
  dropoff_lon: overrides.dropoff_lon ?? 76.92848,
  dropoff_2gis_url: overrides.dropoff_2gis_url ?? null,
  dropoff_apartment: overrides.dropoff_apartment ?? null,
  dropoff_entrance: overrides.dropoff_entrance ?? null,
  dropoff_floor: overrides.dropoff_floor ?? null,
  is_private_house: overrides.is_private_house ?? null,
  price_amount: overrides.price_amount ?? 1500,
  price_currency: overrides.price_currency ?? 'KZT',
  distance_km: overrides.distance_km ?? 5,
  channel_message_id: overrides.channel_message_id ?? null,
  created_at: overrides.created_at ?? new Date('2024-01-01T00:00:00Z'),
});

const cloneOrderRow = (row) => ({ ...row });

const createTestDatabase = () => {
  const orders = new Map();
  const users = new Map();

  const query = async (text, params = []) => {
    const normalized = normalizeSql(text);

    if (normalized.startsWith("update orders set status = 'claimed'") && normalized.includes('city = $3')) {
      const [id, claimedBy, city] = params;
      const order = orders.get(id);
      if (!order || order.status !== 'open' || order.city !== city) {
        return { rows: [] };
      }

      order.status = 'claimed';
      order.claimed_by = claimedBy;
      order.claimed_at = new Date();
      return { rows: [cloneOrderRow(order)] };
    }

    if (normalized.startsWith("update orders set status = 'claimed'") && normalized.includes('claimed_by is null')) {
      const [id, claimedBy] = params;
      const order = orders.get(id);
      if (!order || order.status !== 'open' || order.claimed_by !== null) {
        return { rows: [] };
      }

      order.status = 'claimed';
      order.claimed_by = claimedBy;
      order.claimed_at = new Date();
      order.channel_message_id = null;
      return { rows: [cloneOrderRow(order)] };
    }

    if (normalized.startsWith("update orders set status = 'open'")) {
      const [id, claimedBy] = params;
      const order = orders.get(id);
      if (!order || order.status !== 'claimed' || order.claimed_by !== claimedBy) {
        return { rows: [] };
      }

      order.status = 'open';
      order.claimed_by = null;
      order.claimed_at = null;
      order.channel_message_id = null;
      return { rows: [cloneOrderRow(order)] };
    }

    if (normalized.startsWith("update orders set status = 'claimed'") && normalized.includes("status = 'done'")) {
      const [id, executorId] = params;
      const order = orders.get(id);
      if (!order || order.status !== 'done' || order.claimed_by !== executorId) {
        return { rows: [] };
      }

      order.status = 'claimed';
      order.completed_at = null;
      return { rows: [cloneOrderRow(order)] };
    }

    if (normalized.startsWith("update orders set status = 'done'")) {
      const [id, claimedBy] = params;
      const order = orders.get(id);
      if (!order || order.status !== 'claimed' || order.claimed_by !== claimedBy) {
        return { rows: [] };
      }

      order.status = 'done';
      order.completed_at = new Date();
      return { rows: [cloneOrderRow(order)] };
    }

    if (normalized.startsWith('select count(*)::int as count from orders')) {
      const count = Array.from(orders.values()).filter((order) =>
        order.status === 'open' || order.status === 'claimed',
      ).length;
      return { rows: [{ count }] };
    }

    if (
      normalized.startsWith('select exists ( select 1 from orders where claimed_by = $1') &&
      normalized.includes("status = 'claimed'")
    ) {
      const [executorId] = params;
      const hasActiveOrder = Array.from(orders.values()).some(
        (order) => order.claimed_by === executorId && order.status === 'claimed',
      );

      return { rows: [{ has_active_order: hasActiveOrder }] };
    }

    if (normalized.startsWith('update users set has_active_order = $2')) {
      const [telegramId, hasActiveOrder, updatedAt] = params;
      const user = users.get(telegramId);
      if (!user) {
        throw new Error(`User ${telegramId} not found`);
      }

      user.has_active_order = hasActiveOrder;
      user.updated_at = updatedAt ?? new Date();
      users.set(telegramId, user);
      return { rows: [] };
    }

    if (normalized.startsWith('select has_active_order from users where tg_id = $1')) {
      const [telegramId] = params;
      const user = users.get(telegramId);
      return { rows: user ? [{ has_active_order: user.has_active_order }] : [] };
    }

    throw new Error(`Unsupported query: ${normalized}`);
  };

  return {
    client: { query },
    seedOrder: (order) => {
      orders.set(order.id, cloneOrderRow(order));
    },
    seedUser: (user) => {
      users.set(user.tg_id, { ...user });
    },
  };
};

test('order lifecycle updates users.has_active_order flag', async () => {
  const db = createTestDatabase();
  const executorId = 12345;

  db.seedUser({ tg_id: executorId, has_active_order: false, updated_at: null });
  db.seedOrder(createOrderRow({ id: 1 }));

  const claimed = await tryClaimOrder(db.client, 1, executorId, 'almaty');
  assert.ok(claimed, 'order should be claimed');

  let result = await db.client.query('SELECT has_active_order FROM users WHERE tg_id = $1', [executorId]);
  assert.equal(result.rows[0]?.has_active_order, true, 'claim should set has_active_order to true');

  const released = await tryReleaseOrder(db.client, 1, executorId);
  assert.ok(released, 'order should be released');

  result = await db.client.query('SELECT has_active_order FROM users WHERE tg_id = $1', [executorId]);
  assert.equal(result.rows[0]?.has_active_order, false, 'release should reset has_active_order');

  const reclaimed = await tryClaimOrder(db.client, 1, executorId, 'almaty');
  assert.ok(reclaimed, 'order should be reclaimed');

  result = await db.client.query('SELECT has_active_order FROM users WHERE tg_id = $1', [executorId]);
  assert.equal(result.rows[0]?.has_active_order, true, 'reclaim should set has_active_order to true');

  const completed = await tryCompleteOrder(db.client, 1, executorId);
  assert.ok(completed, 'order should be completed');

  result = await db.client.query('SELECT has_active_order FROM users WHERE tg_id = $1', [executorId]);
  assert.equal(result.rows[0]?.has_active_order, false, 'complete should reset has_active_order');

  const restored = await tryRestoreCompletedOrder(db.client, 1, executorId);
  assert.ok(restored, 'order should be restored');

  result = await db.client.query('SELECT has_active_order FROM users WHERE tg_id = $1', [executorId]);
  assert.equal(result.rows[0]?.has_active_order, true, 'restore should set has_active_order to true again');
});
