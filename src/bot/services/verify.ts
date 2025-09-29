import type { BotContext, ExecutorFlowState } from '../types';
import { EXECUTOR_VERIFICATION_PHOTO_COUNT } from '../types';

import { getExecutorRoleCopy } from '../copy';

import { MINUTE, remainingTime } from '../../utils/time';

const DEFAULT_COOLDOWN_MS = 10 * MINUTE;

export interface VerificationPromptOptions {
  requiredPhotos?: number;
}

export const buildVerificationPrompt = (
  options: VerificationPromptOptions = {},
): string => {
  const required = Math.max(1, options.requiredPhotos ?? EXECUTOR_VERIFICATION_PHOTO_COUNT);
  const lines = [
    `Для доступа к заказам пришлите ${required} фотографии документов:`,
    '1. Фото удостоверения личности (лицевая сторона).',
    '2. Фото удостоверения личности (оборотная сторона).',
  ];

  if (required >= 3) {
    lines.push('3. Селфи с удостоверением личности в руках.');
  }

  if (required > 3) {
    lines.push(`Всего требуется ${required} фото.`);
  }

  lines.push('', 'Можно отправить все фото одним альбомом или отдельными сообщениями в этот чат.');
  return lines.join('\n');
};

export interface VerificationSummaryOptions {
  photoCount?: number;
}

export const buildVerificationSummary = (
  ctx: BotContext,
  state: ExecutorFlowState,
  options: VerificationSummaryOptions = {},
): string => {
  const applicant = ctx.auth.user;
  const role = state.role;
  if (!role) {
    throw new Error('Cannot build verification summary without executor role');
  }
  const copy = getExecutorRoleCopy(role);
  const verification = state.verification[role];
  const lines = [
    `🆕 Новая заявка на верификацию ${copy.genitive}.`,
    `Роль: ${copy.noun} (${role})`,
    `Telegram ID: ${ctx.from?.id ?? 'неизвестно'}`,
  ];

  if (applicant?.username) {
    lines.push(`Username: @${applicant.username}`);
  }

  const fullName = [applicant?.firstName, applicant?.lastName]
    .filter((part) => Boolean(part && part.trim().length > 0))
    .join(' ')
    .trim();

  if (fullName) {
    lines.push(`Имя: ${fullName}`);
  }

  const phone = ctx.auth.user.phone ?? ctx.session.phoneNumber;
  if (phone) {
    lines.push(`Телефон: ${phone}`);
  }

  const uploaded = options.photoCount ?? verification.uploadedPhotos.length;
  lines.push(`Фотографии: ${uploaded}/${verification.requiredPhotos}.`);

  if (verification.submittedAt) {
    lines.push(`Отправлено: ${new Date(verification.submittedAt).toLocaleString('ru-RU')}`);
  }

  return lines.join('\n');
};

export const remainingVerificationCooldown = (
  state: ExecutorFlowState,
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
): number => {
  const role = state.role;
  if (!role) {
    return 0;
  }
  const verification = state.verification[role];
  if (!verification.submittedAt) {
    return 0;
  }

  const until = verification.submittedAt + cooldownMs;
  return Math.max(0, remainingTime(until, now) ?? 0);
};

export const shouldThrottleVerification = (
  state: ExecutorFlowState,
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
): boolean => remainingVerificationCooldown(state, now, cooldownMs) > 0;
