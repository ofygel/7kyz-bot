ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_client_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_claimed_by_fkey;

ALTER TABLE orders
  ADD CONSTRAINT orders_client_id_fkey
    FOREIGN KEY (client_id) REFERENCES users(tg_id) ON DELETE SET NULL;

ALTER TABLE orders
  ADD CONSTRAINT orders_claimed_by_fkey
    FOREIGN KEY (claimed_by) REFERENCES users(tg_id) ON DELETE SET NULL;
