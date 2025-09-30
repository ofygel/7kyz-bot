import { config } from '../../config';
import { getPlanChoiceLabel } from '../../domain/executorPlans';
import type { ExecutorPlanRecord } from '../../types';

export const REMINDER_OFFSETS_HOURS = [-48, -24, -3, 0, 24] as const;

export const REMINDER_STAGE_LABELS = [
  'T-48',
  'T-24',
  'T-3',
  'T',
  'T+24',
] as const;

const formatDateTime = (value: Date): string =>
  new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(value);

export const formatPlanChoice = (plan: ExecutorPlanRecord): string =>
  getPlanChoiceLabel(plan.planChoice);

export const formatPlanStatus = (plan: ExecutorPlanRecord): string => {
  switch (plan.status) {
    case 'active':
      return 'активен';
    case 'blocked':
      return 'заблокирован';
    case 'completed':
      return 'завершён';
    case 'cancelled':
      return 'отменён';
    default:
      return plan.status;
  }
};

export const buildPlanSummary = (plan: ExecutorPlanRecord): string => {
  const lines: string[] = [];
  lines.push(`ID плана: ${plan.id}`);
  lines.push(`Телефон: ${plan.phone}`);
  if (plan.nickname) {
    lines.push(`Ник/ID: ${plan.nickname}`);
  }
  lines.push(`Тариф: ${formatPlanChoice(plan)}`);
  lines.push(`Старт: ${formatDateTime(plan.startAt)}`);
  lines.push(`Окончание: ${formatDateTime(plan.endsAt)}`);
  lines.push(`Статус: ${formatPlanStatus(plan)}${plan.muted ? ' (уведомления отключены)' : ''}`);
  lines.push(`Текущий этап напоминаний: ${REMINDER_STAGE_LABELS[plan.reminderIndex] ?? 'завершён'}`);
  const nextReminderOffset = REMINDER_OFFSETS_HOURS[plan.reminderIndex];
  if (nextReminderOffset === undefined) {
    lines.push('Ближайшее напоминание: выполнены все');
  } else {
    const nextReminderAt = new Date(plan.endsAt.getTime() + nextReminderOffset * 60 * 60 * 1000);
    lines.push(`Ближайшее напоминание: ${formatDateTime(nextReminderAt)}`);
  }
  if (plan.comment) {
    lines.push('', `Комментарий: ${plan.comment}`);
  }
  return lines.join('\n');
};

export const buildReminderMessage = (
  plan: ExecutorPlanRecord,
  reminderIndex: number,
): string => {
  const stageLabel = REMINDER_STAGE_LABELS[reminderIndex] ?? 'T';
  const lines: string[] = [];
  lines.push(`⏰ Напоминание ${stageLabel}`);
  lines.push(`Телефон: ${plan.phone}`);
  if (plan.nickname) {
    lines.push(`Ник/ID: ${plan.nickname}`);
  }
  lines.push(`План: ${formatPlanChoice(plan)}`);
  lines.push(`Старт: ${formatDateTime(plan.startAt)}`);
  lines.push(`Окончание: ${formatDateTime(plan.endsAt)}`);
  if (plan.comment) {
    lines.push('', `Комментарий: ${plan.comment}`);
  }
  return lines.join('\n');
};
