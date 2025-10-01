import type { ExecutorRole } from './types';

export const copy = {
  inactivityNudge: '⏳ Похоже, вы отвлеклись. Продолжить можно кнопками ниже.',
  expiredButton: 'Кнопка устарела — отправляю актуальное меню…',
  tooFrequent: 'Слишком часто. Попробуйте через секунду.',
  waiting: 'Принял. Обрабатываю…',
  undoExpired: 'Время на отмену вышло.',
  undoUnavailable: 'Отменить это действие уже нельзя.',
  orderUndoReleaseRestored: 'Заказ вернулся к вам.',
  orderUndoReleaseFailed: 'Не удалось вернуть заказ: его уже забрали.',
  orderUndoCompleteRestored: 'Вернул заказ в работу.',
  orderUndoCompleteFailed: 'Не удалось вернуть заказ в работу.',
  orderUndoReleaseClientNotice: (shortId: string | number) =>
    `ℹ️ Исполнитель снова взял заказ №${shortId}.`,
  orderUndoCompletionClientNotice: (shortId: string | number) =>
    `ℹ️ Исполнитель возобновил работу над заказом №${shortId}.`,
  back: '⬅ Назад',
  refresh: '🔄 Обновить',
  resume: '🔄 Продолжить',
  home: '🏠 Главное меню',
  errorRecovered: 'Произошёл сбой, но я вернул вас к последнему шагу.',
  errorGeneric: 'Произошёл сбой. Попробуйте повторить действие чуть позже.',
  invalidPhone: (example = '+7 777 123-45-67') => `Уточните телефон в формате E.164 (пример: ${example}).`,
  statusLine: (emoji: string, text: string) => `${emoji} ${text}`,
  clientMiniStatus: (cityLabel?: string) =>
    [cityLabel ? `🏙️ Город: ${cityLabel}` : null].filter(Boolean).join('\n'),
  executorMiniStatus: (
    cityLabel: string | undefined,
    docs: { uploaded: number; required: number },
  ) =>
    [
      cityLabel ? `🏙️ Город: ${cityLabel}` : null,
      `🛡️ Документы: ${docs.uploaded}/${docs.required}`,
    ].filter(Boolean).join('\n'),
  orderChannelCard: (kind: 'taxi' | 'delivery', price: string, city: string) =>
    `Новый заказ • ${kind === 'taxi' ? '🚕 Такси' : '📦 Доставка'}\n${city} • ${price}`,
  orderAcceptedToast: 'Заказ закреплён за вами.',
  orderAlreadyTakenToast: 'Увы, заказ уже принят другим исполнителем.',
  orderReleasedToast: 'Вы сняты с заказа.',
  orderPhoneRequired:
    '📱 Подтвердите номер телефона в личном чате с ботом, чтобы брать заказы.',
  orderAccessBlocked:
    '🚫 Доступ к заказам ограничен. Обратитесь в поддержку для разблокировки.',
  noAccess: 'Недостаточно прав для действия.',
  serviceUnavailable: 'Сервис временно недоступен. Попробуйте позже.',
};

interface ExecutorRoleCopy {
  emoji: string;
  noun: string;
  genitive: string;
  pluralGenitive: string;
}

const EXECUTOR_ROLE_COPY: Record<ExecutorRole, ExecutorRoleCopy> = {
  courier: {
    emoji: '🚚',
    noun: 'курьер',
    genitive: 'курьера',
    pluralGenitive: 'курьеров',
  },
  driver: {
    emoji: '🚗',
    noun: 'водитель',
    genitive: 'водителя',
    pluralGenitive: 'водителей',
  },
};

export const getExecutorRoleCopy = (role: ExecutorRole): ExecutorRoleCopy =>
  EXECUTOR_ROLE_COPY[role] ?? EXECUTOR_ROLE_COPY.courier;

export type { ExecutorRoleCopy };
