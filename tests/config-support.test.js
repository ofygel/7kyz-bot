const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

require('ts-node/register/transpile-only');

const requireFn = createRequire(__filename);

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

test('loadConfig exposes support contact details from environment', () => {
  ensureEnv('BOT_TOKEN', 'test-bot-token');
  ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');

  const previousUsername = process.env.SUPPORT_USERNAME;
  const previousUrl = process.env.SUPPORT_URL;
  const modulePath = requireFn.resolve('../src/config/env');

  process.env.SUPPORT_USERNAME = '@env_support';
  process.env.SUPPORT_URL = 'https://t.me/env_support';

  delete require.cache[modulePath];

  try {
    const { loadConfig } = requireFn(modulePath);
    const loaded = loadConfig();

    assert.equal(loaded.support.username, 'env_support');
    assert.equal(loaded.support.mention, '@env_support');
    assert.equal(loaded.support.url, 'https://t.me/env_support');
  } finally {
    if (typeof previousUsername === 'undefined') {
      delete process.env.SUPPORT_USERNAME;
    } else {
      process.env.SUPPORT_USERNAME = previousUsername;
    }

    if (typeof previousUrl === 'undefined') {
      delete process.env.SUPPORT_URL;
    } else {
      process.env.SUPPORT_URL = previousUrl;
    }

    delete require.cache[modulePath];
  }
});
