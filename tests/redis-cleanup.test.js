const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

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
ensureEnv('SUPPORT_USERNAME', 'test_support');
ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');
ensureEnv('REDIS_URL', 'redis://localhost:6379');

test('redis client is closed during app cleanup', { concurrency: 1 }, async () => {
  const originalProcessOnce = process.once;
  const originalProcessExit = process.exit;
  const onceHandlers = new Map();

  process.once = (event, handler) => {
    const handlers = onceHandlers.get(event) ?? [];
    handlers.push(handler);
    onceHandlers.set(event, handlers);
  };

  let exitResolve;
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });
  process.exit = () => {
    exitResolve();
  };

  const originalModuleLoad = Module._load;
  const mockRedisInstance = {
    quitCalls: 0,
    async quit() {
      this.quitCalls += 1;
    },
    on() {},
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'ioredis') {
      return class FakeRedis {
        constructor() {
          return mockRedisInstance;
        }
      };
    }

    return originalModuleLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/config/index')];
  delete require.cache[require.resolve('../src/infra/redis')];
  delete require.cache[require.resolve('../src/app')];

  const redisModule = require('../src/infra/redis');
  Module._load = originalModuleLoad;
  const appModule = require('../src/app');

  const poolModule = require('../src/db');
  const originalPoolEnd = poolModule.pool.end;
  poolModule.pool.end = async () => {};

  const originalStop = appModule.app.stop.bind(appModule.app);
  appModule.app.stop = () => {};

  try {
    const client = redisModule.getRedisClient();
    assert.equal(client, mockRedisInstance, 'mock redis instance should be used');

    const sigtermHandlers = onceHandlers.get('SIGTERM');
    assert.ok(sigtermHandlers?.length, 'SIGTERM handler should be registered');
    const handler = sigtermHandlers[0];

    handler();
    await exitPromise;

    assert.equal(mockRedisInstance.quitCalls, 1, 'redis quit should be invoked once during cleanup');
  } finally {
    process.once = originalProcessOnce;
    process.exit = originalProcessExit;
    Module._load = originalModuleLoad;
    poolModule.pool.end = originalPoolEnd;
    appModule.app.stop = originalStop;
    delete require.cache[require.resolve('../src/app')];
    delete require.cache[require.resolve('../src/infra/redis')];
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/config/index')];
  }
});
