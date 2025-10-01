import { config } from '../config';
import type { ExecutorPlanChoice } from '../types';

type PaidExecutorPlanChoice = Exclude<ExecutorPlanChoice, 'trial'>;

const PAID_PLAN_CHOICES: readonly PaidExecutorPlanChoice[] = ['7', '15', '30'];

const DEFAULT_PAID_PLAN_DURATIONS: Record<PaidExecutorPlanChoice, number> = {
  '7': 7,
  '15': 15,
  '30': 30,
};

const PLAN_INDEX_BY_CHOICE: Record<PaidExecutorPlanChoice, number> = {
  '7': 0,
  '15': 1,
  '30': 2,
};

let planDurationsOverride: readonly number[] | null = null;

const normaliseDurationDays = (value: number, fallback = 1): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  if (rounded <= 0) {
    return fallback;
  }

  return rounded;
};

const getConfiguredPlanDurations = (): readonly number[] =>
  planDurationsOverride ?? config.domain.planDurations;

export const getTrialPlanDurationDays = (): number =>
  normaliseDurationDays(config.subscriptions.trialDays);

const isPaidPlanChoice = (choice: ExecutorPlanChoice): choice is PaidExecutorPlanChoice =>
  choice !== 'trial';

const getPaidPlanDurationDays = (choice: PaidExecutorPlanChoice): number => {
  const index = PLAN_INDEX_BY_CHOICE[choice];
  const fallback = DEFAULT_PAID_PLAN_DURATIONS[choice];

  if (typeof index !== 'number') {
    return fallback;
  }

  const durations = getConfiguredPlanDurations();
  const candidate = durations[index];

  if (!Number.isFinite(candidate)) {
    return fallback;
  }

  return normaliseDurationDays(candidate, fallback);
};

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

export const getDayNoun = (days: number): string => {
  const mod10 = days % 10;
  const mod100 = days % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'день';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return 'дня';
  }

  return 'дней';
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
      return `План на ${days} ${getDayNoun(days)}`;
    }
    default:
      return `План ${choice} дней`;
  }
};

export const __testing__ = {
  setPlanDurationsOverride: (values: readonly number[] | null): void => {
    planDurationsOverride = values;
  },
  resetPlanDurationsOverride: (): void => {
    planDurationsOverride = null;
  },
  getPaidPlanChoices: (): readonly PaidExecutorPlanChoice[] => PAID_PLAN_CHOICES,
};
