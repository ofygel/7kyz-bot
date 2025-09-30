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
ensureEnv('SUPPORT_USERNAME', 'test_support');
ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
ensureEnv('WEBHOOK_DOMAIN', 'example.com');
ensureEnv('WEBHOOK_SECRET', 'secret');

const { ui } = require('../src/bot/ui');
const menu = require('../src/bot/flows/executor/menu');
const verificationFlow = require('../src/bot/flows/executor/verification');

const createPhotoMessage = (messageId, fileId, uniqueId) => ({
  message_id: messageId,
  date: 1,
  media_group_id: 'album-1',
  chat: { id: 999, type: 'private' },
  photo: [
    { file_id: `${fileId}-preview`, file_unique_id: `${uniqueId}-preview`, width: 90, height: 90 },
    { file_id: fileId, file_unique_id: uniqueId, width: 1280, height: 960 },
  ],
});

test('handleIncomingPhoto processes album photos once', { concurrency: false }, async (t) => {
  const progressSteps = [];
  const originalUiStep = ui.step;
  ui.step = async (_ctx, options) => {
    progressSteps.push(options);
    return { messageId: progressSteps.length, sent: true };
  };
  t.after(() => {
    ui.step = originalUiStep;
  });

  const ctx = {
    chat: { id: 999, type: 'private' },
    session: {
      executor: undefined,
      ui: { steps: {}, homeActions: [], pendingCityAction: undefined },
      city: 'almaty',
    },
    reply: async () => {},
    auth: {
      user: {
        telegramId: undefined,
        username: 'courieruser',
        firstName: 'Courier',
        lastName: 'User',
        role: 'executor',
        executorKind: 'courier',
        status: 'active_executor',
        phoneVerified: true,
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked: false,
        hasActiveOrder: false,
        citySelected: 'almaty',
      },
      executor: {
        verifiedRoles: { courier: false, driver: false },
        hasActiveSubscription: false,
        isVerified: false,
      },
      isModerator: false,
    },
    telegram: {},
  };

  const state = menu.ensureExecutorState(ctx);
  state.role = 'courier';
  state.verification.courier.status = 'collecting';
  state.verification.courier.uploadedPhotos = [];
  state.verification.courier.processedMediaGroups = {};

  const albumMessages = [
    createPhotoMessage(201, 'photo-1', 'unique-1'),
    createPhotoMessage(202, 'photo-2', 'unique-2'),
    createPhotoMessage(203, 'photo-3', 'unique-3'),
  ];

  const { handleIncomingPhoto } = verificationFlow.__private__;

  for (const message of albumMessages) {
    ctx.message = message;
    const handled = await handleIncomingPhoto(ctx, message);
    assert.equal(handled, true, 'photo message should be handled');
  }

  const verificationState = ctx.session.executor.verification.courier;

  assert.equal(
    verificationState.uploadedPhotos.length,
    3,
    'three unique photos from the album should be stored',
  );

  const albumState = verificationState.processedMediaGroups['album-1'];
  assert.ok(albumState, 'album state should be tracked');
  assert.deepEqual(
    albumState.photoUniqueIds.sort(),
    ['unique-1', 'unique-2', 'unique-3'],
    'all album photos should be tracked by unique id',
  );

  const progressMessages = progressSteps.filter(
    (step) => step.id === 'executor:verification:progress',
  );
  assert.equal(progressMessages.length, 1, 'progress should be reported once for the album');
  assert.ok(
    progressMessages[0].text.includes('Фото 3/3 получено'),
    'progress message should reflect three uploaded photos',
  );
});

test('verification info text mentions support contact from config', () => {
  const { __private__ } = require('../src/bot/flows/executor/verification');
  const { config } = require('../src/config');

  const text = __private__.buildVerificationInfoText('courier');

  assert.ok(
    text.includes(config.support.mention),
    'verification info should include support mention from config',
  );
});
