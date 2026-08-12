CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  sku          TEXT UNIQUE NOT NULL,
  resource_uri TEXT NOT NULL,
  stock        INTEGER NOT NULL CHECK (stock >= 0),
  price_cents  INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','fulfilled')),
  customer_ref TEXT,
  total_cents  INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  product_id       TEXT NOT NULL REFERENCES products(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL
);
