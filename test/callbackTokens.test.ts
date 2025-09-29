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
process.env.WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN ?? 'example.com';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secret';
process.env.CALLBACK_SIGN_SECRET = process.env.CALLBACK_SIGN_SECRET ?? 'test-secret';

void (async () => {
  const {
    wrapCallbackData,
    tryDecodeCallbackData,
    CALLBACK_SURROGATE_TOKEN_PREFIX,
    CALLBACK_SURROGATE_ACTION,
  } = await import('../src/bot/services/callbackTokens');
  const { ROLE_PICK_EXECUTOR_ACTION } = await import('../src/bot/flows/executor/roleSelectionConstants');

  const secret = 'test-secret';

  const wrapped = wrapCallbackData(ROLE_PICK_EXECUTOR_ACTION, {
    secret,
    userId: 987654321,
    keyboardNonce: 'keyboard-nonce',
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

  console.log('callback tokens surrogate guard test: OK');
})();
