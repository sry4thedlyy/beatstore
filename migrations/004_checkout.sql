ALTER TABLE orders ADD COLUMN request_key uuid;
ALTER TABLE orders ADD COLUMN accepted_at timestamptz;
CREATE UNIQUE INDEX orders_request_key ON orders (user_id, request_key) WHERE request_key IS NOT NULL;
ALTER TABLE payments ADD COLUMN confirmation_url text;
ALTER TABLE payments ADD COLUMN checked_at timestamptz;
ALTER TABLE payments ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE payments ADD COLUMN lease_until timestamptz;
ALTER TABLE payments ADD COLUMN lease_token uuid;

-- A durable local provider simulator, separate from the shop's payment status.
CREATE TABLE demo_provider_payments (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  amount_kopecks integer NOT NULL CHECK (amount_kopecks > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','canceled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
