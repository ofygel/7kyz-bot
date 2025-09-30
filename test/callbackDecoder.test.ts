import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type StoredRecord = {
  token: string;
  action: string;
  payload: unknown;
  expiresAt: Date;
};

const requireFn = createRequire(__filename);
const callbackMapPath = requireFn.resolve('../src/db/callbackMap.ts');
const menusPath = requireFn.resolve('../src/bot/ui/menus.ts');

const callbackStore = new Map<string, StoredRecord>();
let deleteCalls = 0;
let renderMenuCalls = 0;

(requireFn.cache as Record<string, NodeModule | undefined>)[callbackMapPath] = {
  id: callbackMapPath,
  filename: callbackMapPath,
  loaded: true,
  exports: {
    upsertCallbackMapRecord: async (record: StoredRecord): Promise<void> => {
      callbackStore.set(record.token, { ...record });
    },
    loadCallbackMapRecord: async (token: string): Promise<StoredRecord | null> =>
      callbackStore.get(token) ?? null,
    listCallbackMapRecords: async (): Promise<StoredRecord[]> => Array.from(callbackStore.values()),
    deleteCallbackMapRecord: async (token: string): Promise<void> => {
      deleteCalls += 1;
      callbackStore.delete(token);
    },
  },
} as unknown as NodeModule;

(requireFn.cache as Record<string, NodeModule | undefined>)[menusPath] = {
  id: menusPath,
  filename: menusPath,
  loaded: true,
  exports: {
    renderMenuFor: async (): Promise<void> => {
      renderMenuCalls += 1;
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
process.env.CALLBACK_SIGN_SECRET = process.env.CALLBACK_SIGN_SECRET ?? 'test-secret';

void (async () => {
  const {
    wrapCallbackData,
    CALLBACK_SURROGATE_TOKEN_PREFIX,
    CALLBACK_SURROGATE_ACTION,
  } = await import('../src/bot/services/callbackTokens');
  const { callbackDecoder } = await import('../src/bot/middlewares/callbackDecoder');

  const secret = 'test-secret';
  const longRaw = `surrogate:${'x'.repeat(90)}`;
  const surrogate = wrapCallbackData(longRaw, { secret, ttlSeconds: 60 });

  assert.ok(
    surrogate.startsWith(`${CALLBACK_SURROGATE_TOKEN_PREFIX}:`),
    'Long callback data must be replaced with a surrogate token',
  );

  const storedRecord = callbackStore.get(surrogate);
  assert.ok(storedRecord, 'Surrogate payload should be stored for later resolution');
  assert.equal(storedRecord?.action, CALLBACK_SURROGATE_ACTION);

  const middleware = callbackDecoder();
  let nextCalled = false;
  let answered = false;

  const ctx: any = {
    callbackQuery: { data: surrogate },
    state: {},
    answerCbQuery: async (): Promise<void> => {
      answered = true;
    },
  };

  await middleware(ctx, async () => {
    nextCalled = true;
    assert.equal(
      ctx.callbackQuery?.data,
      longRaw,
      'Callback data should be restored before reaching the handler',
    );
  });

  assert.ok(nextCalled, 'Next middleware should run for valid surrogate callbacks');
  assert.equal(answered, false, 'Successful surrogates should not trigger answerCbQuery');
  const statePayload = (ctx.state as Record<string, unknown>).callbackPayload as
    | { raw: string; version: string }
    | undefined;
  assert.ok(statePayload, 'Middleware must expose the wrapped payload on context state');
  assert.equal(
    statePayload?.raw,
    longRaw,
    'Callback payload state should reflect the original callback data',
  );
  assert.equal(renderMenuCalls, 0, 'Valid callbacks should not trigger menu rendering');

  // Expire the stored payload and ensure it is cleaned up on access.
  const existing = callbackStore.get(surrogate);
  assert.ok(existing);
  callbackStore.set(surrogate, {
    ...existing!,
    expiresAt: new Date(Date.now() - 1_000),
  });

  let expiredNextCalled = false;
  let expiredAnswered = false;

  const expiredCtx: any = {
    callbackQuery: { data: surrogate },
    state: {},
    answerCbQuery: async (): Promise<void> => {
      expiredAnswered = true;
    },
  };

  await middleware(expiredCtx, async () => {
    expiredNextCalled = true;
  });

  assert.equal(expiredNextCalled, false, 'Expired surrogates should not reach downstream handlers');
  assert.equal(expiredAnswered, true, 'Expired surrogates should inform the user via answerCbQuery');
  assert.equal(renderMenuCalls > 0, true, 'Expired surrogates should trigger menu rendering');
  assert.equal(callbackStore.has(surrogate), false, 'Expired surrogate entries should be deleted');
  assert.ok(deleteCalls > 0, 'Expired surrogates should be purged from storage');

  console.log('callback decoder surrogate test: OK');
})();
