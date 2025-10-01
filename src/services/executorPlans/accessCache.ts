import { logger } from '../../config';
import { refreshExecutorOrderAccessCache } from '../../bot/services/executorAccess';
import type { ExecutorPlanRecord } from '../../types';

export const refreshExecutorOrderAccessCacheForPlan = async (
  plan: Pick<ExecutorPlanRecord, 'id' | 'chatId' | 'phone' | 'status'>,
): Promise<void> => {
  try {
    await refreshExecutorOrderAccessCache(plan.chatId, {
      phone: plan.phone,
      isBlocked: plan.status === 'blocked',
    });
  } catch (error) {
    logger.warn(
      { err: error, planId: plan.id, chatId: plan.chatId },
      'Failed to refresh executor order access cache for plan',
    );
  }
};
