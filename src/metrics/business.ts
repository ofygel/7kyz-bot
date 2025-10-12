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
    name: 'servicebot_active_orders',
    help: 'Текущее количество активных заказов в статусах open|claimed|in_progress',
    registers: [metricsRegistry],
  });

const createExecutorFinishErrorCounter = (): NoLabelCounter =>
  new Counter<string>({
    name: 'servicebot_executor_finish_error_total',
    help: 'Счётчик ошибок при завершении заказов исполнителем',
    registers: [metricsRegistry],
  });

const createFailedPaymentsCounter = (): NoLabelCounter =>
  new Counter<string>({
    name: 'servicebot_failed_payment_total',
    help: 'Счётчик неуспешных попыток платежа',
    registers: [metricsRegistry],
  });

export const activeOrdersGauge = createActiveOrdersGauge();
export const failedPaymentsCounter = createFailedPaymentsCounter();
export const executorFinishErrorCounter = createExecutorFinishErrorCounter();
