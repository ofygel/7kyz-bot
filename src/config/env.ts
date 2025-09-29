import { config as loadEnv } from 'dotenv';
import type { LevelWithSilent } from 'pino';

loadEnv();

const REQUIRED_ENV_VARS = [
  'BOT_TOKEN',
  'DATABASE_URL',
  'KASPI_CARD',
  'KASPI_NAME',
  'KASPI_PHONE',
  'WEBHOOK_DOMAIN',
  'WEBHOOK_SECRET',
] as const;

type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

const LOG_LEVELS: LevelWithSilent[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

type LogTransport = 'pretty' | 'json';

const getTrimmedEnv = (key: string): string | undefined => {
  const value = process.env[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const missingVars = REQUIRED_ENV_VARS.filter((key) => !getTrimmedEnv(key));

if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

const parseBoolean = (value: string | undefined, defaultValue = false): boolean => {
  if (typeof value === 'undefined') {
    return defaultValue;
  }

  const normalised = value.trim().toLowerCase();

  if (normalised.length === 0) {
    return defaultValue;
  }

  switch (normalised) {
    case '1':
    case 'true':
    case 'yes':
      return true;
    default:
      return false;
  }
};

const resolveLogLevel = (value: string | undefined): LevelWithSilent => {
  if (!value) {
    return 'info';
  }

  const normalised = value.toLowerCase() as LevelWithSilent;
  if (!LOG_LEVELS.includes(normalised)) {
    throw new Error(`Unsupported LOG_LEVEL provided: ${value}`);
  }

  return normalised;
};

const resolveLogTransport = (value: string | undefined): LogTransport => {
  if (!value) {
    return 'pretty';
  }

  const normalised = value.trim().toLowerCase();
  if (normalised === 'pretty') {
    return 'pretty';
  }

  if (normalised === 'json') {
    return 'json';
  }

  throw new Error(`Unsupported PINO_TRANSPORT provided: ${value}`);
};

const parseWarnHours = (value: string | undefined): number => {
  if (!value) {
    return 24;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('SUB_WARN_HOURS_BEFORE must be a positive number');
  }

  return parsed;
};

const parseTariffValue = (envKey: string, defaultValue: number): number => {
  const raw = getTrimmedEnv(envKey);

  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${envKey} must be a non-negative number`);
  }

  return parsed;
};

const parsePositiveNumber = (envKey: string, defaultValue: number): number => {
  const raw = getTrimmedEnv(envKey);

  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envKey} must be a positive number`);
  }

  return parsed;
};

const parseOptionalPositiveNumber = (envKey: string): number | undefined => {
  const raw = getTrimmedEnv(envKey);
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envKey} must be a positive number`);
  }

  return parsed;
};

const parseOptionalChatId = (envKey: string): number | undefined => {
  const raw = getTrimmedEnv(envKey);
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed === 0) {
    throw new Error(`${envKey} must be a non-zero integer`);
  }

  return parsed;
};

const parsePositiveInt = (envKey: string, defaultValue: number): number => {
  const raw = getTrimmedEnv(envKey);

  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envKey} must be a positive integer`);
  }

  return parsed;
};

const getRequiredString = (key: RequiredEnvVar): string => {
  const value = getTrimmedEnv(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
};

const getOptionalString = (key: string): string | undefined => getTrimmedEnv(key);

const getCronExpression = (key: string, defaultValue: string): string =>
  getTrimmedEnv(key) ?? defaultValue;

export interface TariffConfig {
  baseFare: number;
  perKm: number;
  minimumFare: number;
}

export interface PricingConfig {
  taxi: TariffConfig;
  delivery: TariffConfig;
}

export interface TariffRates {
  base: number;
  perKm: number;
  perMin: number;
}

const DEFAULT_TAXI_TARIFF: TariffConfig = {
  baseFare: 700,
  perKm: 200,
  minimumFare: 700,
};

const DEFAULT_DELIVERY_TARIFF: TariffConfig = {
  baseFare: 900,
  perKm: 250,
  minimumFare: 900,
};

const parseTariffConfig = (prefix: string, defaults: TariffConfig): TariffConfig => ({
  baseFare: parseTariffValue(`${prefix}_BASE_FARE`, defaults.baseFare),
  perKm: parseTariffValue(`${prefix}_PER_KM`, defaults.perKm),
  minimumFare: parseTariffValue(`${prefix}_MINIMUM_FARE`, defaults.minimumFare),
});

const loadPricingConfig = (): PricingConfig => ({
  taxi: parseTariffConfig('TAXI', DEFAULT_TAXI_TARIFF),
  delivery: parseTariffConfig('DELIVERY', DEFAULT_DELIVERY_TARIFF),
});

const parseGeneralTariff = (): TariffRates | null => {
  const base = parseOptionalPositiveNumber('TARIFF_BASE');
  const perKm = parseOptionalPositiveNumber('TARIFF_PER_KM');
  const perMin = parseOptionalPositiveNumber('TARIFF_PER_MIN');

  const definedValues = [base, perKm, perMin].filter((value) => value !== undefined).length;
  if (definedValues === 0) {
    return null;
  }

  if (definedValues !== 3) {
    throw new Error('TARIFF_BASE, TARIFF_PER_KM and TARIFF_PER_MIN must be defined together');
  }

  return {
    base: base as number,
    perKm: perKm as number,
    perMin: perMin as number,
  } satisfies TariffRates;
};

const parseSubscriptionPrices = (): {
  sevenDays: number;
  fifteenDays: number;
  thirtyDays: number;
  currency: 'KZT';
} => ({
  sevenDays: parsePositiveNumber('SUB_PRICE_7', 5000),
  fifteenDays: parsePositiveNumber('SUB_PRICE_15', 9000),
  thirtyDays: parsePositiveNumber('SUB_PRICE_30', 16000),
  currency: 'KZT',
});

export interface AppConfig {
  nodeEnv: string;
  logLevel: LevelWithSilent;
  logTransport: LogTransport;
  logRateLimit: number;
  bot: {
    token: string;
    callbackSignSecret?: string;
    callbackTtlSeconds: number;
  };
  features: {
    trialEnabled: boolean;
    executorReplyKeyboard: boolean;
    reportsEnabled: boolean;
    nudgerEnabled: boolean;
  };
  webhook: {
    domain: string;
    secret: string;
  };
  database: {
    url: string;
    ssl: boolean;
    pool: {
      max: number;
      idleTimeoutMs: number;
      connectionTimeoutMs: number;
      statementTimeoutMs: number;
      queryTimeoutMs: number;
    };
  };
  session: {
    ttlSeconds: number;
    redis: { url: string; keyPrefix: string } | null;
  };
  channels: {
    bindVerifyChannelId?: number;
  };
  city: {
    default?: string;
  };
  timezone: string;
  jobs: {
    nudger: string;
    nudgerEnabled: boolean;
    nudgerInactivitySeconds: number;
    subscription: string;
    metrics: string;
    paymentReminder: string;
    phoneSyncIntervalMs: number;
  };
  tariff: TariffRates | null;
  subscriptions: {
    warnHoursBefore: number;
    trialDays: number;
    prices: {
      sevenDays: number;
      fifteenDays: number;
      thirtyDays: number;
      currency: string;
    };
    payment: {
      kaspi: {
        card: string;
        name: string;
        phone: string;
      };
      driversChannelId?: number;
      driversChannelInvite?: string;
    };
  };
  pricing: PricingConfig;
}

export const loadConfig = (): AppConfig => {
  const redisUrl = getOptionalString('REDIS_URL');
  const sessionCachePrefix = getOptionalString('SESSION_CACHE_PREFIX') ?? 'session:';

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: resolveLogLevel(process.env.PINO_LEVEL ?? process.env.LOG_LEVEL),
    logTransport: resolveLogTransport(process.env.PINO_TRANSPORT),
    logRateLimit: 50,
    bot: {
      token: process.env.BOT_TOKEN as string,
      callbackSignSecret: getOptionalString('CALLBACK_SIGN_SECRET'),
      callbackTtlSeconds: parsePositiveInt('CALLBACK_TTL_SECONDS', 600),
    },
    features: {
      trialEnabled: parseBoolean(process.env.FEATURE_TRIAL_ENABLED, true),
      executorReplyKeyboard: parseBoolean(process.env.FEATURE_EXECUTOR_REPLY_KEYBOARD),
      reportsEnabled: parseBoolean(process.env.FEATURE_REPORTS_ENABLED),
      nudgerEnabled: parseBoolean(process.env.FEATURE_NUDGER_ENABLED),
    },
    webhook: {
      domain: getRequiredString('WEBHOOK_DOMAIN'),
      secret: getRequiredString('WEBHOOK_SECRET'),
    },
    database: {
      url: process.env.DATABASE_URL as string,
      ssl: parseBoolean(process.env.DATABASE_SSL),
      pool: {
        max: parsePositiveInt('DATABASE_POOL_MAX', 10),
        idleTimeoutMs: parsePositiveInt('DATABASE_POOL_IDLE_TIMEOUT_MS', 30000),
        connectionTimeoutMs: parsePositiveInt('DATABASE_POOL_CONNECTION_TIMEOUT_MS', 5000),
        statementTimeoutMs: parsePositiveInt('DATABASE_STATEMENT_TIMEOUT_MS', 15000),
        queryTimeoutMs: parsePositiveInt('DATABASE_QUERY_TIMEOUT_MS', 20000),
      },
    },
    session: {
      ttlSeconds: parsePositiveInt('SESSION_TTL_SECONDS', 86400),
      redis: redisUrl
        ? {
            url: redisUrl,
            keyPrefix: sessionCachePrefix,
          }
        : null,
    },
    channels: {
      bindVerifyChannelId: parseOptionalChatId('BIND_VERIFY_CHANNEL_ID'),
    },
    city: {
      default: getOptionalString('CITY_DEFAULT'),
    },
    timezone: getOptionalString('TIMEZONE') ?? 'Asia/Almaty',
    jobs: {
      nudger: getCronExpression('JOBS_NUDGER_CRON', '*/1 * * * *'),
      nudgerEnabled: parseBoolean(process.env.JOBS_NUDGER_ENABLED),
      nudgerInactivitySeconds: parsePositiveInt('JOBS_NUDGER_INACTIVITY_SECONDS', 90),
      subscription: getCronExpression('JOBS_SUBSCRIPTION_CRON', '*/10 * * * *'),
      metrics: getCronExpression('JOBS_METRICS_CRON', '*/60 * * * * *'),
      paymentReminder: getCronExpression('JOBS_PAYMENT_REMINDER_CRON', '*/10 * * * *'),
      phoneSyncIntervalMs: parsePositiveInt('JOBS_PHONE_SYNC_INTERVAL_MS', 5000),
    },
    tariff: parseGeneralTariff(),
    subscriptions: {
      warnHoursBefore: parseWarnHours(process.env.SUB_WARN_HOURS_BEFORE),
      trialDays: parsePositiveNumber('SUB_TRIAL_DAYS', 2),
      prices: parseSubscriptionPrices(),
      payment: {
        kaspi: {
          card: getRequiredString('KASPI_CARD'),
          name: getRequiredString('KASPI_NAME'),
          phone: getRequiredString('KASPI_PHONE'),
        },
        driversChannelId: parseOptionalChatId('DRIVERS_CHANNEL_ID'),
        driversChannelInvite: getOptionalString('DRIVERS_CHANNEL_INVITE'),
      },
    },
    pricing: loadPricingConfig(),
  };
};

export const config: AppConfig = loadConfig();

Object.freeze(config.bot);
Object.freeze(config.features);
Object.freeze(config.webhook);
Object.freeze(config.database.pool);
Object.freeze(config.database);
if (config.session.redis) {
  Object.freeze(config.session.redis);
}
Object.freeze(config.session);
Object.freeze(config.city);
Object.freeze(config.jobs);
if (config.tariff) {
  Object.freeze(config.tariff);
}
Object.freeze(config.subscriptions.prices);
Object.freeze(config.subscriptions.payment.kaspi);
Object.freeze(config.subscriptions.payment);
Object.freeze(config.subscriptions);
Object.freeze(config.pricing.taxi);
Object.freeze(config.pricing.delivery);
Object.freeze(config.pricing);
Object.freeze(config);

export type { RequiredEnvVar };
