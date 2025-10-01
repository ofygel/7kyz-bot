import { config, logger } from '../../config';
import { pool } from '../../db';

export const BIND_VERIFY_CHANNEL = 'bind_verify_channel' as const;
export const ORDERS_CHANNEL = 'orders_channel' as const;
export const STATS_CHANNEL = 'stats_channel' as const;

export type ChannelType =
  | typeof BIND_VERIFY_CHANNEL
  | typeof ORDERS_CHANNEL
  | typeof STATS_CHANNEL;

export interface ChannelBinding {
  type: ChannelType;
  chatId: number;
}

type ChannelColumn = 'verify_channel_id' | 'drivers_channel_id' | 'stats_channel_id';

interface ChannelsRow {
  verify_channel_id: string | number | null;
  drivers_channel_id: string | number | null;
  stats_channel_id: string | number | null;
}

const CHANNEL_COLUMNS: Record<ChannelType, ChannelColumn> = {
  [BIND_VERIFY_CHANNEL]: 'verify_channel_id',
  [ORDERS_CHANNEL]: 'drivers_channel_id',
  [STATS_CHANNEL]: 'stats_channel_id',
};

const parseChatId = (value: string | number): number => {
  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Failed to parse channel identifier: ${value}`);
  }

  return parsed;
};

interface CacheEntry {
  value: ChannelBinding | null;
  expiresAt: number;
}

const BINDING_CACHE = new Map<ChannelType, CacheEntry>();
const LAST_KNOWN_BINDINGS = new Map<ChannelType, ChannelBinding | null>();
const QUERY_FAILURE_LOGGED = new Set<ChannelType>();

const getCacheTtl = (): number => (process.env.NODE_ENV === 'test' ? 0 : 60_000);

const readFromCache = (type: ChannelType): ChannelBinding | null | undefined => {
  const ttl = getCacheTtl();
  if (ttl <= 0) {
    return undefined;
  }

  const entry = BINDING_CACHE.get(type);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    BINDING_CACHE.delete(type);
    return undefined;
  }

  return entry.value;
};

const writeToCache = (type: ChannelType, value: ChannelBinding | null): void => {
  const ttl = getCacheTtl();
  if (ttl <= 0) {
    LAST_KNOWN_BINDINGS.set(type, value);
    return;
  }

  BINDING_CACHE.set(type, { value, expiresAt: Date.now() + ttl });
  LAST_KNOWN_BINDINGS.set(type, value);
};

const resolveConfiguredChatId = (type: ChannelType): number | null => {
  switch (type) {
    case ORDERS_CHANNEL: {
      const configured =
        config.channels.ordersChannelId ?? config.subscriptions.payment.ordersChannelId;
      return typeof configured === 'number' ? configured : null;
    }
    case BIND_VERIFY_CHANNEL: {
      const configured = config.channels.bindVerifyChannelId;
      return typeof configured === 'number' ? configured : null;
    }
    default:
      return null;
  }
};

const getConfiguredBinding = (type: ChannelType): ChannelBinding | null => {
  const chatId = resolveConfiguredChatId(type);
  return chatId === null ? null : ({ type, chatId } satisfies ChannelBinding);
};

export const saveChannelBinding = async (
  binding: ChannelBinding,
): Promise<void> => {
  const configured = getConfiguredBinding(binding.type);
  if (configured) {
    if (configured.chatId !== binding.chatId) {
      throw new Error(
        `Channel ${binding.type} is configured via environment variables and cannot be overridden`,
      );
    }

    writeToCache(binding.type, configured);
    return;
  }

  const column = CHANNEL_COLUMNS[binding.type];

  await pool.query(
    `
      INSERT INTO channels (id, ${column})
      VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE
      SET ${column} = EXCLUDED.${column}
    `,
    [binding.chatId],
  );

  writeToCache(binding.type, binding);
};

export const getChannelBinding = async (
  type: ChannelType,
): Promise<ChannelBinding | null> => {
  const cached = readFromCache(type);
  if (cached !== undefined) {
    return cached;
  }

  const configured = getConfiguredBinding(type);
  if (configured) {
    writeToCache(type, configured);
    return configured;
  }

  const column = CHANNEL_COLUMNS[type];

  let rows: ChannelsRow[];
  try {
    ({ rows } = await pool.query<ChannelsRow>(
      `
        SELECT verify_channel_id, drivers_channel_id, stats_channel_id
        FROM channels
        WHERE id = 1
        LIMIT 1
      `,
    ));
    QUERY_FAILURE_LOGGED.delete(type);
  } catch (error) {
    if (!QUERY_FAILURE_LOGGED.has(type)) {
      logger.error({ err: error, type }, 'Failed to load channel binding');
      QUERY_FAILURE_LOGGED.add(type);
    }

    return LAST_KNOWN_BINDINGS.get(type) ?? null;
  }

  const [row] = rows;
  if (!row) {
    writeToCache(type, null);
    return null;
  }

  const value = row[column];
  if (value === null || value === undefined) {
    writeToCache(type, null);
    return null;
  }

  const binding = {
    type,
    chatId: parseChatId(value),
  } satisfies ChannelBinding;

  writeToCache(type, binding);

  return binding;
};

export const __testing = {
  clearBindingCache: (): void => {
    BINDING_CACHE.clear();
    LAST_KNOWN_BINDINGS.clear();
    QUERY_FAILURE_LOGGED.clear();
  },
};

