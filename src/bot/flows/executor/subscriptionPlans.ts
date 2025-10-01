import { config } from '../../../config';
import { getDayNoun, getPlanChoiceDurationDays } from '../../../domain/executorPlans';

export interface SubscriptionPeriodOption {
  id: string;
  /** Human-readable label describing the duration. */
  label: string;
  /** Number of days covered by the payment. */
  days: number;
  /** Subscription price in Kazakhstani tenge. */
  amount: number;
  /** Currency code used for the payment. */
  currency: string;
}

type PaidSubscriptionPlanId = '7' | '15' | '30';
type SubscriptionPriceKey = 'sevenDays' | 'fifteenDays' | 'thirtyDays';

const PLAN_PRICE_KEYS: Record<PaidSubscriptionPlanId, SubscriptionPriceKey> = {
  '7': 'sevenDays',
  '15': 'fifteenDays',
  '30': 'thirtyDays',
};

const buildSubscriptionPeriodOption = (id: PaidSubscriptionPlanId): SubscriptionPeriodOption => {
  const days = getPlanChoiceDurationDays(id);
  const priceKey = PLAN_PRICE_KEYS[id];

  return {
    id,
    label: `${days} ${getDayNoun(days)}`,
    days,
    amount: config.subscriptions.prices[priceKey],
    currency: config.subscriptions.prices.currency,
  };
};

const PLAN_IDS: readonly PaidSubscriptionPlanId[] = ['7', '15', '30'];

export const getSubscriptionPeriodOptions = (): readonly SubscriptionPeriodOption[] =>
  PLAN_IDS.map((id) => buildSubscriptionPeriodOption(id));

export const findSubscriptionPeriodOption = (
  id: string | undefined,
): SubscriptionPeriodOption | undefined =>
  getSubscriptionPeriodOptions().find((option) => option.id === id);

export const formatSubscriptionAmount = (
  amount: number,
  currency: string,
): string =>
  `${new Intl.NumberFormat('ru-RU').format(amount)} ${currency}`;
