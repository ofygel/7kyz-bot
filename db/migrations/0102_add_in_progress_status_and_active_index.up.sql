-- migrate:up transaction:false
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'in_progress';

CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_active_by_executor_idx
  ON public.orders (claimed_by)
  WHERE status IN ('claimed', 'in_progress');
