import { config } from '../config';
import type { ExecutorPlanChoice } from '../types';

const normaliseDurationDays = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  return Math.max(1, Math.round(value));
};

export const getTrialPlanDurationDays = (): number =>
  normaliseDurationDays(config.subscriptions.trialDays);

export const getPlanChoiceDurationDays = (choice: ExecutorPlanChoice): number => {
  switch (choice) {
    case 'trial':
      return getTrialPlanDurationDays();
    case '7':
      return 7;
    case '15':
      return 15;
    case '30':
      return 30;
    default:
      return 7;
  }
};

export const getPlanChoiceLabel = (choice: ExecutorPlanChoice): string => {
  switch (choice) {
    case 'trial': {
      const days = getTrialPlanDurationDays();
      return `Пробный план (${days} дн.)`;
    }
    case '7':
      return 'План на 7 дней';
    case '15':
      return 'План на 15 дней';
    case '30':
      return 'План на 30 дней';
    default:
      return `План ${choice} дней`;
  }
};
