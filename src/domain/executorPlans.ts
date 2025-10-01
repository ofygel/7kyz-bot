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

const isPaidPlanChoice = (choice: ExecutorPlanChoice): choice is '7' | '15' | '30' =>
  choice !== 'trial';

const getPaidPlanDurationDays = (choice: '7' | '15' | '30'): number =>
  normaliseDurationDays(config.subscriptions.planDurations[choice]);

export const getPlanChoiceDurationDays = (choice: ExecutorPlanChoice): number => {
  switch (choice) {
    case 'trial':
      return getTrialPlanDurationDays();
    default:
      if (isPaidPlanChoice(choice)) {
        return getPaidPlanDurationDays(choice);
      }

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
    case '15':
    case '30': {
      const days = getPlanChoiceDurationDays(choice);
      return `План на ${days} дней`;
    }
    default:
      return `План ${choice} дней`;
  }
};
