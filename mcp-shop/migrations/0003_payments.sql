CREATE TABLE payments (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  amount_cents   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('succeeded','declined','refunded')),
  transaction_id TEXT NOT NULL,
  card_last4     TEXT,
  decline_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
