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

const reports = require('../src/bot/services/reports');
const db = require('../src/db');
const dbUsers = require('../src/db/users');
const cityServices = require('../src/services/users');
const ui = require('../src/bot/ui');

const stubSendStatsReport = (t) => {
  const calls = [];
  const original = reports.sendStatsReport;
  reports.sendStatsReport = async (_telegram, text) => {
    calls.push({ text });
    return { status: 'sent' };
  };
  t.after(() => {
    reports.sendStatsReport = original;
  });
  return calls;
};

test('savePhone sends phone verification stats report', { concurrency: false }, async (t) => {
  const { savePhone } = require('../src/bot/flows/common/phoneCollect');

  const originalQuery = db.pool.query;
  db.pool.query = async () => ({ rows: [] });
  t.after(() => {
    db.pool.query = originalQuery;
  });

  const calls = stubSendStatsReport(t);

  const ctx = {
    chat: { type: 'private', id: 111 },
    from: {
      id: 111,
      username: 'clientuser',
      first_name: 'Client',
      last_name: 'User',
    },
    message: { contact: { phone_number: '+7 (777) 123-45-67', user_id: 111 } },
    session: {
      awaitingPhone: true,
      phoneNumber: undefined,
      user: { id: 111, phoneVerified: false },
      city: 'almaty',
      ephemeralMessages: [],
    },
    auth: {
      user: {
        telegramId: 111,
        username: 'clientuser',
        firstName: 'Client',
        lastName: 'User',
        phoneVerified: false,
        role: 'guest',
        status: 'awaiting_phone',
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked: false,
        hasActiveOrder: false,
        executorKind: undefined,
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
    state: {},
  };

  let nextCalled = false;
  await savePhone(ctx, async () => {
    nextCalled = true;
  });
  assert.ok(nextCalled, 'next middleware should be called');

  const phoneReport = calls.find((call) =>
    call.text.startsWith('📱 Телефон подтверждён'),
  );
  assert.ok(phoneReport, 'phone verification report should be sent');
  assert.equal(
    phoneReport.text,
    [
      '📱 Телефон подтверждён',
      'Пользователь: Client User (@clientuser, ID 111)',
      'Телефон: +7 (777) 123-45-67',
      'Город: Алматы',
    ].join('\n'),
  );
});

test('applyClientRole reports client role assignment', { concurrency: false }, async (t) => {
  const { applyClientRole } = require('../src/bot/flows/client/menu');

  const originalEnsureClientRole = dbUsers.ensureClientRole;
  dbUsers.ensureClientRole = async () => 'test-keyboard-nonce';
  t.after(() => {
    dbUsers.ensureClientRole = originalEnsureClientRole;
  });

  const calls = stubSendStatsReport(t);

  const ctx = {
    chat: { type: 'private', id: 222 },
    from: {
      id: 222,
      username: 'clientperson',
      first_name: 'Client',
      last_name: 'Person',
    },
    session: {
      phoneNumber: '+77000000000',
      user: { id: 222, phoneVerified: true },
      ui: { steps: {}, homeActions: [], pendingCityAction: undefined },
      city: 'almaty',
    },
    auth: {
      user: {
        telegramId: 222,
        username: 'clientperson',
        firstName: 'Client',
        lastName: 'Person',
        phone: undefined,
        phoneVerified: true,
        role: 'guest',
        executorKind: undefined,
        status: 'awaiting_phone',
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked: false,
        citySelected: 'almaty',
        hasActiveOrder: false,
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

  await applyClientRole(ctx);

  const roleReport = calls.find((call) =>
    call.text.startsWith('🎭 Роль пользователя обновлена'),
  );
  assert.ok(roleReport, 'role assignment report should be sent');
  assert.equal(
    roleReport.text,
    [
      '🎭 Роль пользователя обновлена',
      'Пользователь: Client Person (@clientperson, ID 222)',
      'Телефон: +77000000000',
      'Роль: Клиент',
      'Город: Алматы',
    ].join('\n'),
  );
});

test('handleRoleSelection reports executor role assignment', { concurrency: false }, async (t) => {
  const { handleRoleSelection } = require('../src/bot/flows/executor/roleSelect');

  const originalUpdateUserRole = dbUsers.updateUserRole;
  dbUsers.updateUserRole = async () => {};
  t.after(() => {
    dbUsers.updateUserRole = originalUpdateUserRole;
  });

  const calls = stubSendStatsReport(t);

  const ctx = {
    chat: { id: 333, type: 'private' },
    from: {
      id: 333,
      username: 'execuser',
      first_name: 'Exec',
      last_name: 'User',
    },
    session: {
      phoneNumber: undefined,
      executor: undefined,
      ui: { steps: {}, homeActions: [], pendingCityAction: undefined },
      city: 'almaty',
    },
    auth: {
      user: {
        telegramId: 333,
        username: 'execuser',
        firstName: 'Exec',
        lastName: 'User',
        phone: '+77001112233',
        phoneVerified: true,
        role: 'guest',
        executorKind: undefined,
        status: 'active_client',
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked: false,
        citySelected: 'almaty',
        hasActiveOrder: false,
      },
      executor: {
        verifiedRoles: { courier: false, driver: false },
        hasActiveSubscription: false,
        isVerified: false,
      },
      isModerator: false,
    },
    telegram: {},
    answerCbQuery: async () => {},
    deleteMessage: async () => {},
    editMessageReplyMarkup: async () => {},
    reply: async () => ({ message_id: 1 }),
  };

  const clientMenuModule = require('../src/ui/clientMenu');
  const originalHideClientMenu = clientMenuModule.hideClientMenu;
  clientMenuModule.hideClientMenu = async () => {};
  t.after(() => {
    clientMenuModule.hideClientMenu = originalHideClientMenu;
  });

  const commandsModule = require('../src/bot/services/commands');
  const originalSetChatCommands = commandsModule.setChatCommands;
  commandsModule.setChatCommands = async () => {};
  t.after(() => {
    commandsModule.setChatCommands = originalSetChatCommands;
  });

  const originalUiStep = ui.ui.step;
  const originalUiTrack = ui.ui.trackStep;
  ui.ui.step = async () => ({ messageId: 1, sent: true });
  ui.ui.trackStep = async () => {};
  t.after(() => {
    ui.ui.step = originalUiStep;
    ui.ui.trackStep = originalUiTrack;
  });

  await handleRoleSelection(ctx, 'courier');

  const roleReport = calls.find((call) =>
    call.text.startsWith('🎭 Роль пользователя обновлена'),
  );
  assert.ok(roleReport, 'executor role assignment report should be sent');
  assert.equal(
    roleReport.text,
    [
      '🎭 Роль пользователя обновлена',
      'Пользователь: Exec User (@execuser, ID 333)',
      'Телефон: +77001112233',
      'Роль: Исполнитель — курьер (courier)',
      'Город: Алматы',
    ].join('\n'),
  );
});

test('registerCityAction reports city selection', { concurrency: false }, async (t) => {
  const { registerCityAction } = require('../src/bot/flows/common/citySelect');

  const originalSetUserCitySelected = cityServices.setUserCitySelected;
  cityServices.setUserCitySelected = async () => {};
  t.after(() => {
    cityServices.setUserCitySelected = originalSetUserCitySelected;
  });

  const calls = stubSendStatsReport(t);

  const fakeBot = {
    handler: null,
    action(_pattern, handler) {
      this.handler = handler;
    },
  };

  registerCityAction(fakeBot);
  assert.ok(typeof fakeBot.handler === 'function', 'city action handler should be registered');

  const ctx = {
    match: ['city:almaty', 'almaty'],
    chat: { id: 444, type: 'private' },
    from: {
      id: 444,
      username: 'execuser',
      first_name: 'Exec',
      last_name: 'User',
    },
    auth: {
      user: {
        telegramId: 444,
        username: 'execuser',
        firstName: 'Exec',
        lastName: 'User',
        phone: '+77002223344',
        phoneVerified: true,
        role: 'executor',
        executorKind: 'courier',
        status: 'active_executor',
        verifyStatus: 'none',
        subscriptionStatus: 'none',
        isVerified: false,
        isBlocked: false,
        citySelected: 'astana',
        hasActiveOrder: false,
      },
      executor: {
        verifiedRoles: { courier: false, driver: false },
        hasActiveSubscription: false,
        isVerified: false,
      },
      isModerator: false,
    },
    session: {
      city: undefined,
      phoneNumber: undefined,
      client: undefined,
      executor: { roleSelectionStage: 'city', awaitingRoleSelection: true, jobs: { stage: 'idle' } },
      ui: { steps: {}, homeActions: [], pendingCityAction: undefined },
    },
    telegram: {},
    answerCbQuery: async () => {},
    reply: async () => ({ message_id: 2 }),
    editMessageText: async () => {},
  };

  const originalUiStep = ui.ui.step;
  ui.ui.step = async () => ({ messageId: 2, sent: false });
  t.after(() => {
    ui.ui.step = originalUiStep;
  });

  await fakeBot.handler(ctx, async () => {});

  const cityReport = calls.find((call) =>
    call.text.startsWith('🗺️ Город обновлён'),
  );
  assert.ok(cityReport, 'city selection report should be sent');
  assert.equal(
    cityReport.text,
    [
      '🗺️ Город обновлён',
      'Пользователь: Exec User (@execuser, ID 444)',
      'Телефон: +77002223344',
      'Роль: Исполнитель — курьер (courier)',
      'Город: Алматы',
    ].join('\n'),
  );
});
