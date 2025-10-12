import { config, logger } from '../src/config';
import { pool } from '../src/db/client';
import { cleanupStaleFlowSteps } from '../src/infra/redisMaintenance';
import { closeRedisClient } from '../src/infra/redis';

const ORDER_RETENTION_DAYS = 90;
const FLOW_STEP_RETENTION_SECONDS = 7 * 24 * 60 * 60;

void config;

const deleteClosedOrdersOlderThan = async (days: number): Promise<number> => {
  const statuses = ['cancelled', 'finished', 'expired'] as const;
  const { rows } = await pool.query<{ id: number }>(
    `
      DELETE FROM orders
      WHERE status = ANY($1::order_status[])
        AND created_at < now() - ($2::int * INTERVAL '1 day')
      RETURNING id
    `,
    [statuses, Math.max(1, Math.floor(days))],
  );

  return rows.length;
};

const run = async (): Promise<void> => {
  logger.info('Starting maintenance cleanup');

  try {
    const removedOrders = await deleteClosedOrdersOlderThan(ORDER_RETENTION_DAYS);
    logger.info({ removedOrders }, 'Removed historical closed orders');
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete old closed orders');
  }

  try {
    const removedKeys = await cleanupStaleFlowSteps({ olderThanSeconds: FLOW_STEP_RETENTION_SECONDS });
    logger.info({ removedKeys }, 'Cleaned up stale flow step keys');
  } catch (error) {
    logger.error({ err: error }, 'Failed to cleanup flow step keys');
  }

  await pool.end();
  await closeRedisClient();

  logger.info('Maintenance cleanup finished');
};

void run().catch((error) => {
  logger.fatal({ err: error }, 'Cleanup script failed');
  process.exitCode = 1;
});
