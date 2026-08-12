-- Rebuilds `payments` for the hosted-checkout-link flow: a payment starts
-- 'pending' when the link is created and is resolved later, asynchronously,
-- by a webhook call — SQLite (D1) can't ALTER a CHECK constraint in place,
-- so the table is recreated.
ALTER TABLE payments RENAME TO payments_old;

CREATE TABLE payments (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  amount_cents   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','succeeded','declined','refunded')),
  provider       TEXT NOT NULL DEFAULT 'mock',
  checkout_token TEXT UNIQUE,
  transaction_id TEXT,
  card_last4     TEXT,
  decline_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

INSERT INTO payments (id, order_id, amount_cents, currency, status, provider, checkout_token, transaction_id, card_last4, decline_reason, created_at, updated_at)
  SELECT id, order_id, amount_cents, currency, status, 'mock', NULL, transaction_id, card_last4, decline_reason, created_at, updated_at
  FROM payments_old;

DROP TABLE payments_old;
