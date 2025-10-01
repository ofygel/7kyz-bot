import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const requireFn = createRequire(__filename);
const callbackMapPath = requireFn.resolve('../src/db/callbackMap.ts');

const callbackStore = new Map<string, {
  token: string;
  action: string;
  payload: unknown;
  expiresAt: Date;
}>();

(requireFn.cache as Record<string, NodeModule | undefined>)[callbackMapPath] = {
  id: callbackMapPath,
  filename: callbackMapPath,
  loaded: true,
  exports: {
    upsertCallbackMapRecord: async (record: {
      token: string;
      action: string;
      payload: unknown;
      expiresAt: Date;
    }): Promise<void> => {
      callbackStore.set(record.token, { ...record });
    },
    loadCallbackMapRecord: async (token: string): Promise<unknown> =>
      callbackStore.get(token) ?? null,
    listCallbackMapRecords: async (): Promise<unknown[]> => Array.from(callbackStore.values()),
    deleteCallbackMapRecord: async (token: string): Promise<void> => {
      callbackStore.delete(token);
    },
  },
} as unknown as NodeModule;

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/db';
process.env.KASPI_CARD = process.env.KASPI_CARD ?? '1234';
process.env.KASPI_NAME = process.env.KASPI_NAME ?? 'Test User';
process.env.KASPI_PHONE = process.env.KASPI_PHONE ?? '+70000000000';
process.env.SUPPORT_USERNAME = process.env.SUPPORT_USERNAME ?? 'test_support';
process.env.SUPPORT_URL = process.env.SUPPORT_URL ?? 'https://t.me/test_support';
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';
process.env.HMAC_SECRET = process.env.HMAC_SECRET ?? 'test-secret';

void (async () => {
  const {
    wrapCallbackData,
    tryDecodeCallbackData,
    CALLBACK_SURROGATE_TOKEN_PREFIX,
    CALLBACK_SURROGATE_ACTION,
    bindInlineKeyboardToUser,
  } = await import('../src/bot/services/callbackTokens');
  const { logger } = await import('../src/config');
  const { ROLE_PICK_EXECUTOR_ACTION } = await import('../src/bot/flows/executor/roleSelectionConstants');

  const secret = 'test-secret';

  const wrapped = wrapCallbackData(ROLE_PICK_EXECUTOR_ACTION, {
    secret,
    userId: 987654321,
    keyboardNonce: 'n',
    bindToUser: true,
    ttlSeconds: 300,
  });

  assert.ok(
    wrapped.length <= 64,
    'Wrapped callback data for ROLE_PICK_EXECUTOR_ACTION must fit into 64 characters',
  );
  assert.notEqual(
    wrapped,
    ROLE_PICK_EXECUTOR_ACTION,
    'Binding metadata should be applied when callback data fits within the allowed length',
  );
  assert.ok(
    wrapped.includes('#'),
    'Wrapped callback data should contain the metadata separator',
  );

  let oversizeOutcome: import('../src/bot/services/callbackTokens').WrapCallbackOutcome | undefined;
  const longRaw = 'x'.repeat(130);
  const oversizeWrapped = wrapCallbackData(longRaw, {
    secret,
    userId: 111111,
    keyboardNonce: 'nonce-value',
    bindToUser: true,
    ttlSeconds: 120,
    onResult: (outcome) => {
      oversizeOutcome = outcome;
    },
  });

  assert.ok(oversizeWrapped.length <= 64, 'Guarded callback data should never exceed 64 characters');
  assert.ok(
    oversizeWrapped.startsWith(`${CALLBACK_SURROGATE_TOKEN_PREFIX}:`),
    'Oversized callbacks should resolve to a surrogate token',
  );

  const storedRecord = callbackStore.get(oversizeWrapped);
  assert.ok(storedRecord, 'Surrogate callback payload must be persisted');
  assert.equal(
    storedRecord?.action,
    CALLBACK_SURROGATE_ACTION,
    'Surrogate payloads should be stored under the expected action key',
  );

  const storedPayload = storedRecord?.payload as { raw: string; data: string } | undefined;
  assert.ok(storedPayload, 'Surrogate payload must include the original data');
  assert.equal(storedPayload?.raw, longRaw, 'Original callback data should be preserved in storage');

  const decodedStored = tryDecodeCallbackData(storedPayload!.data);
  assert.ok(decodedStored.ok, 'Stored surrogate payload must be decodable');
  assert.equal(
    decodedStored.wrapped.raw,
    longRaw,
    'Decoded surrogate payload should reproduce the original callback data',
  );

  const msUntilExpiry = storedRecord!.expiresAt.getTime() - Date.now();
  assert.ok(
    Math.abs(msUntilExpiry - 120_000) < 2_000,
    'Surrogate payload should inherit the configured TTL window',
  );

  assert.ok(
    oversizeOutcome && oversizeOutcome.status === 'wrapped' && oversizeOutcome.reason === 'raw-too-long',
    'Oversized callback data should be reported as wrapped via surrogate indirection',
  );

  callbackStore.clear();

  const warnings: unknown[][] = [];
  const originalWarn = logger.warn;

  const keyboard: import('telegraf/typings/core/types/typegram').InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: 'Orders', callback_data: 'client:orders:list' }]],
  };

  let boundKeyboard: import('telegraf/typings/core/types/typegram').InlineKeyboardMarkup | undefined;
  try {
    (logger as unknown as { warn: (...args: unknown[]) => void }).warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    const ctx = {
      auth: {
        user: {
          telegramId: 123_456_789_012,
          keyboardNonce: 'nonce-value',
        },
      },
    } satisfies Partial<import('../src/bot/types').BotContext>;

    boundKeyboard = bindInlineKeyboardToUser(ctx as import('../src/bot/types').BotContext, keyboard);
  } finally {
    (logger as unknown as { warn: typeof originalWarn }).warn = originalWarn;
  }

  assert.ok(boundKeyboard, 'Binding inline keyboard should return a keyboard instance');
  assert.notEqual(boundKeyboard, keyboard, 'Binding should produce a new keyboard reference when changes apply');

  const boundButton = boundKeyboard!.inline_keyboard?.[0]?.[0];
  assert.ok(boundButton, 'Bound keyboard should preserve the original button');
  assert.ok(boundButton!.callback_data, 'Bound button must include callback data');
  assert.ok(
    boundButton!.callback_data!.startsWith(`${CALLBACK_SURROGATE_TOKEN_PREFIX}:`),
    'Oversized bound callbacks should be replaced with surrogate tokens',
  );

  const storedBoundRecord = callbackStore.get(boundButton!.callback_data!);
  assert.ok(storedBoundRecord, 'Surrogate payload for bound callback should be persisted');
  assert.equal(
    storedBoundRecord?.action,
    CALLBACK_SURROGATE_ACTION,
    'Stored surrogate should be associated with the surrogate action key',
  );

  const storedBoundPayload = storedBoundRecord?.payload as { raw: string; data: string } | undefined;
  assert.ok(storedBoundPayload, 'Surrogate payload should include raw and wrapped data');
  assert.equal(
    storedBoundPayload?.raw,
    'client:orders:list',
    'Original callback payload must be preserved when using surrogate binding',
  );

  const decodedBound = tryDecodeCallbackData(storedBoundPayload!.data);
  assert.ok(decodedBound.ok, 'Persisted surrogate payload should decode successfully');
  assert.equal(decodedBound.wrapped.user, BigInt(123_456_789_012).toString(36));
  assert.equal(decodedBound.wrapped.nonce, 'noncevalue');

  assert.deepEqual(warnings, [], 'Binding callbacks via surrogate should not emit warnings');

  console.log('callback tokens surrogate guard test: OK');
})();
