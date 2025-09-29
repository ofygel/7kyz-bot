import { config } from '../../../config';

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

export const SUBSCRIPTION_PERIOD_OPTIONS: readonly SubscriptionPeriodOption[] = [
  {
    id: '7',
    label: '7 дней',
    days: 7,
    amount: config.subscriptions.prices.sevenDays,
    currency: config.subscriptions.prices.currency,
  },
  {
    id: '15',
    label: '15 дней',
    days: 15,
    amount: config.subscriptions.prices.fifteenDays,
    currency: config.subscriptions.prices.currency,
  },
  {
    id: '30',
    label: '30 дней',
    days: 30,
    amount: config.subscriptions.prices.thirtyDays,
    currency: config.subscriptions.prices.currency,
  },
] as const;

export const findSubscriptionPeriodOption = (
  id: string | undefined,
): SubscriptionPeriodOption | undefined =>
  SUBSCRIPTION_PERIOD_OPTIONS.find((option) => option.id === id);

export const formatSubscriptionAmount = (
  amount: number,
  currency: string,
): string =>
  `${new Intl.NumberFormat('ru-RU').format(amount)} ${currency}`;
