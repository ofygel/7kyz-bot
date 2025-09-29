/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { Counter, Gauge } from 'prom-client';
import type { Counter as PromCounter, Gauge as PromGauge } from 'prom-client';

import { metricsRegistry } from './prometheus';

/**
 * Business‑level Prometheus metrics.
 * These complement the default process / HTTP metrics already exposed.
 */
type NoLabelGauge = PromGauge<string>;
type NoLabelCounter = PromCounter<string>;

const createActiveOrdersGauge = (): NoLabelGauge =>
  new Gauge<string>({
    name: 'freedombot_active_orders',
    help: 'Текущее количество активных заказов в статусах open|claimed',
    registers: [metricsRegistry],
  });

const createFailedPaymentsCounter = (): NoLabelCounter =>
  new Counter<string>({
    name: 'freedombot_failed_payment_total',
    help: 'Счётчик неуспешных попыток платежа',
    registers: [metricsRegistry],
  });

export const activeOrdersGauge = createActiveOrdersGauge();
export const failedPaymentsCounter = createFailedPaymentsCounter();
