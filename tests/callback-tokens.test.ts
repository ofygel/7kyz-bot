import test from 'node:test';
import assert from 'node:assert/strict';

import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import type { BotContext } from '../src/bot/types';
type WrapCallback = typeof import('../src/bot/services/callbackTokens')['wrapCallbackData'];

const ensureEnv = (key: string, value: string): void => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

test('bindInlineKeyboardToUser falls back to original callbacks when wrapping fails', async () => {
  ensureEnv('BOT_TOKEN', 'test-bot-token');
  ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
  ensureEnv('SUPPORT_USERNAME', 'test_support');
  ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
  ensureEnv('HMAC_SECRET', 'secret');

  const { bindInlineKeyboardToUser } = await import('../src/bot/services/callbackTokens');

  const ctx = {
    auth: {
      user: {
        telegramId: 42,
        keyboardNonce: 'test-nonce',
      },
    },
  } as unknown as BotContext;

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: 'First', callback_data: 'first:action' }],
      [{ text: 'Second', callback_data: 'second:action' }],
    ],
  };

  const wrapStub: WrapCallback = async (raw) => {
    if (raw === 'first:action') {
      throw new Error('wrap failure');
    }
    return `${raw}#wrapped`;
  };

  const bound = await bindInlineKeyboardToUser(ctx, keyboard, wrapStub);

  assert.ok(bound, 'Binding should still produce a keyboard when wrapping fails');
  assert.notEqual(bound, keyboard, 'Successful bindings should clone the keyboard');

  const firstButton = bound!.inline_keyboard?.[0]?.[0] ?? {};
  const secondButton = bound!.inline_keyboard?.[1]?.[0] ?? {};

  assert.equal(
    (firstButton as { callback_data?: string }).callback_data,
    'first:action',
    'Failed bindings should preserve original callback data',
  );

  assert.equal(
    (secondButton as { callback_data?: string }).callback_data,
    'second:action#wrapped',
    'Other callbacks should still be wrapped successfully',
  );

  assert.equal(
    keyboard.inline_keyboard[0][0].callback_data,
    'first:action',
    'Original keyboard should remain unchanged for the first button',
  );

  assert.equal(
    keyboard.inline_keyboard[1][0].callback_data,
    'second:action',
    'Original keyboard should remain unchanged for the second button',
  );
});
