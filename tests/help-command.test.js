const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');

const ensureEnv = (key, value) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

const ensureBotEnv = () => {
  ensureEnv('BOT_TOKEN', 'test-bot-token');
  ensureEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
  ensureEnv('KASPI_CARD', '0000 0000 0000 0000');
  ensureEnv('KASPI_NAME', 'Test User');
  ensureEnv('KASPI_PHONE', '+70000000000');
  ensureEnv('SUPPORT_USERNAME', 'test_support');
  ensureEnv('SUPPORT_URL', 'https://t.me/test_support');
  ensureEnv('WEBHOOK_DOMAIN', 'example.com');
  ensureEnv('WEBHOOK_SECRET', 'secret');
};

const { handleHelp } = require('../src/bot/commands/help');

const createTestContext = () => {
  const replyMessages = [];
  const ctx = {
    chat: { id: 4242, type: 'private' },
    session: {
      client: {
        delivery: { stage: 'idle' },
        taxi: { stage: 'idle' },
      },
      support: { status: 'idle' },
      executor: {
        awaitingRoleSelection: false,
        roleSelectionStage: undefined,
      },
    },
    auth: {
      user: { role: 'client' },
      executor: {},
      isModerator: false,
    },
    replyMessages,
    reply: async (text) => {
      replyMessages.push(text);
      return { message_id: replyMessages.length };
    },
  };

  return ctx;
};

test('help suggests sending 2ГИС link when collecting delivery pickup', async () => {
  ensureBotEnv();
  const ctx = createTestContext();
  ctx.session.client.delivery = { stage: 'collectingPickup' };

  await handleHelp(ctx);

  const expected = [
    '📦 Оформляем доставку.',
    'Отправьте ссылку 2ГИС на точку забора посылки. Нажмите «Открыть 2ГИС» в сообщении бота или пришлите ссылку на выбранное место.',
    'Если подходящий адрес уже сохранён, выберите его из списка под сообщением.',
    'Чтобы отменить оформление, отправьте /cancel.',
  ].join('\n');

  assert.equal(ctx.replyMessages.length, 1);
  assert.equal(ctx.replyMessages[0], expected);
});

test('help highlights comment requirements for delivery orders', async () => {
  ensureBotEnv();
  const ctx = createTestContext();
  ctx.session.client.delivery = {
    stage: 'collectingComment',
    pickup: { address: 'Алматы, ул. Пушкина 1' },
    dropoff: { address: 'Алматы, пр. Абая 10' },
    recipientPhone: '+77001234567',
  };

  await handleHelp(ctx);

  const expected = [
    '📦 Оформляем доставку.',
    '📦 Забор: Алматы, ул. Пушкина 1.',
    '📮 Доставка: Алматы, пр. Абая 10.',
    '📞 Телефон получателя: +77001234567.',
    '',
    'Добавьте обязательный комментарий для курьера:',
    '• Что нужно забрать или доставить.',
    '• Кому передать и как связаться.',
    '• Подъезд, код домофона и другие ориентиры.',
    'Чтобы отменить оформление, отправьте /cancel.',
  ].join('\n');

  assert.equal(ctx.replyMessages.length, 1);
  assert.equal(ctx.replyMessages[0], expected);
});

test('help reminds about confirmation buttons for taxi orders', async () => {
  ensureBotEnv();
  const ctx = createTestContext();
  ctx.session.client.taxi = {
    stage: 'awaitingConfirmation',
    pickup: { address: 'Алматы, Толе би 50' },
    dropoff: { address: 'Алматы, Байзакова 100' },
  };

  await handleHelp(ctx);

  const expected = [
    '🚕 Проверьте детали поездки.',
    'Используйте кнопки под сообщением, чтобы подтвердить поездку или отменить оформление.',
    'Если требуется изменить адреса, отмените оформление и начните заново.',
  ].join('\n');

  assert.equal(ctx.replyMessages.length, 1);
  assert.equal(ctx.replyMessages[0], expected);
});

test('help points to support instructions when awaiting moderator reply', async () => {
  ensureBotEnv();
  const ctx = createTestContext();
  ctx.session.support.status = 'awaiting_message';

  await handleHelp(ctx);

  const expected = [
    '🆘 Вы на шаге обращения в поддержку.',
    'Опишите проблему одним сообщением — мы передадим его модератору.',
    'Если хотите вернуться в меню без сообщения, отправьте /start.',
  ].join('\n');

  assert.equal(ctx.replyMessages.length, 1);
  assert.equal(ctx.replyMessages[0], expected);
});

test('help explains executor role selection steps', async () => {
  ensureBotEnv();
  const ctx = createTestContext();
  ctx.session.client.delivery = { stage: 'idle' };
  ctx.session.client.taxi = { stage: 'idle' };
  ctx.session.executor.awaitingRoleSelection = true;
  ctx.session.executor.roleSelectionStage = 'executorKind';

  await handleHelp(ctx);

  const expected = [
    'Выбираете специализацию исполнителя.',
    'Используйте кнопки «Курьер» или «Водитель» под сообщением. Кнопка «Назад» вернёт к выбору роли.',
  ].join('\n');

  assert.equal(ctx.replyMessages.length, 1);
  assert.equal(ctx.replyMessages[0], expected);
});
