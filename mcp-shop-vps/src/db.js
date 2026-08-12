import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { decideCharge, newCheckoutToken, mockRefund } from "./payments.js";

export function openDb(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

const now = () => new Date().toISOString();

export function findProductBySku(db, sku) {
  return db.prepare("SELECT * FROM products WHERE sku = ? AND active = 1").get(sku);
}

/** Unlike findProductBySku, sees unpublished products too — for admin use only. */
export function findProductBySkuAny(db, sku) {
  return db.prepare("SELECT * FROM products WHERE sku = ?").get(sku);
}

export function createProduct(db, { sku, title, description = "", category = "", priceCents, stock = 0, active = true }) {
  if (findProductBySkuAny(db, sku)) return { ok: false, reason: "sku_exists" };
  const id = randomUUID();
  const timestamp = now();
  db.prepare(
    "INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, title, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)"
  ).run(id, sku, `product://${sku}`, stock, priceCents, active ? 1 : 0, title, description, category, timestamp, timestamp);
  return { ok: true, product: findProductBySkuAny(db, sku) };
}

export function updateProduct(db, sku, patch) {
  if (!findProductBySkuAny(db, sku)) return { ok: false, reason: "not_found" };
  const fields = [];
  const args = [];
  for (const [key, column] of [
    ["title", "title"],
    ["description", "description"],
    ["category", "category"],
    ["priceCents", "price_cents"],
  ]) {
    if (patch[key] !== undefined) {
      fields.push(`${column} = ?`);
      args.push(patch[key]);
    }
  }
  if (fields.length === 0) return { ok: false, reason: "no_fields" };
  fields.push("updated_at = ?");
  args.push(now(), sku);
  db.prepare(`UPDATE products SET ${fields.join(", ")} WHERE sku = ?`).run(...args);
  return { ok: true, product: findProductBySkuAny(db, sku) };
}

export function setStock(db, sku, stock) {
  if (!findProductBySkuAny(db, sku)) return { ok: false, reason: "not_found" };
  db.prepare("UPDATE products SET stock = ?, updated_at = ? WHERE sku = ?").run(stock, now(), sku);
  return { ok: true, product: findProductBySkuAny(db, sku) };
}

export function setPublished(db, sku, active) {
  if (!findProductBySkuAny(db, sku)) return { ok: false, reason: "not_found" };
  db.prepare("UPDATE products SET active = ?, updated_at = ? WHERE sku = ?").run(active ? 1 : 0, now(), sku);
  return { ok: true, product: findProductBySkuAny(db, sku) };
}

export function searchProducts(db, { query, category, inStock, limit, offset }) {
  const clauses = ["active = 1"];
  const args = [];
  if (query) {
    clauses.push("(sku LIKE ? OR title LIKE ? OR description LIKE ?)");
    args.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (category) {
    clauses.push("category = ?");
    args.push(category);
  }
  if (inStock) clauses.push("stock > 0");
  args.push(limit, offset);
  const sql = `SELECT * FROM products WHERE ${clauses.join(" AND ")} ORDER BY sku LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args);
}

class InvalidSkuError extends Error {
  constructor(sku) {
    super(`invalid sku: ${sku}`);
    this.sku = sku;
  }
}

class InsufficientStockError extends Error {
  constructor(sku) {
    super(`insufficient stock: ${sku}`);
    this.sku = sku;
  }
}

/**
 * Creates the order as "pending" and reserves stock immediately (decremented
 * now, not when the webhook confirms) — real ACID transaction, so a failed
 * item rolls everything back. Reserving at link-creation time avoids
 * overselling while the customer is on the checkout page, at the cost of no
 * automatic release if they abandon it (no expiry job here — a known gap,
 * would need a cron/TTL sweep to reclaim abandoned reservations).
 */
export function createOrder(db, items, customerRef) {
  const run = db.transaction((items, customerRef) => {
    const resolved = [];
    for (const item of items) {
      const product = findProductBySku(db, item.sku);
      if (!product) throw new InvalidSkuError(item.sku);
      const result = db
        .prepare("UPDATE products SET stock = stock - ?, updated_at = ? WHERE sku = ? AND stock >= ?")
        .run(item.quantity, now(), item.sku, item.quantity);
      if (result.changes === 0) throw new InsufficientStockError(item.sku);
      resolved.push({ product, quantity: item.quantity });
    }

    const orderId = randomUUID();
    const totalCents = resolved.reduce((sum, r) => sum + r.product.price_cents * r.quantity, 0);
    const currency = resolved[0]?.product.currency ?? "USD";
    const timestamp = now();
    const checkoutToken = newCheckoutToken();

    db.prepare(
      "INSERT INTO orders (id, status, customer_ref, total_cents, currency, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?, ?, ?)"
    ).run(orderId, customerRef ?? null, totalCents, currency, timestamp, timestamp);

    for (const r of resolved) {
      db.prepare(
        "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)"
      ).run(randomUUID(), orderId, r.product.id, r.quantity, r.product.price_cents);
    }

    db.prepare(
      "INSERT INTO payments (id, order_id, amount_cents, currency, status, provider, checkout_token, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 'mock', ?, ?, ?)"
    ).run(randomUUID(), orderId, totalCents, currency, checkoutToken, timestamp, timestamp);

    return {
      orderId,
      status: "pending",
      totalCents,
      currency,
      items: resolved.map((r) => ({
        sku: r.product.sku,
        title: r.product.title,
        quantity: r.quantity,
        unit_price_cents: r.product.price_cents,
      })),
      payment: { status: "pending", checkoutToken },
    };
  });

  try {
    const order = run(items, customerRef);
    return { ok: true, order };
  } catch (error) {
    if (error instanceof InvalidSkuError) return { ok: false, reason: "invalid_sku", sku: error.sku };
    if (error instanceof InsufficientStockError) return { ok: false, reason: "insufficient_stock", sku: error.sku };
    throw error;
  }
}

export function findPaymentByCheckoutToken(db, checkoutToken) {
  return db.prepare("SELECT * FROM payments WHERE checkout_token = ?").get(checkoutToken);
}

/**
 * Processes an (already signature-verified) payment webhook. Idempotent: if
 * the payment is no longer "pending" (already resolved by an earlier call —
 * real providers retry webhooks), this is a no-op that still returns ok so
 * the caller acks the retry instead of erroring on it.
 */
export function confirmPaymentWebhook(db, { checkoutToken, approved, transactionId, cardLast4, declineReason }) {
  const run = db.transaction((checkoutToken) => {
    const payment = findPaymentByCheckoutToken(db, checkoutToken);
    if (!payment) return { ok: false, reason: "not_found" };
    if (payment.status !== "pending") return { ok: true, alreadyProcessed: true, status: payment.status };

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(payment.order_id);
    const timestamp = now();

    if (approved) {
      db.prepare(
        "UPDATE payments SET status = 'succeeded', transaction_id = ?, card_last4 = ?, updated_at = ? WHERE id = ?"
      ).run(transactionId, cardLast4, timestamp, payment.id);
      db.prepare("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?").run(timestamp, order.id);
      return { ok: true, alreadyProcessed: false, status: "succeeded" };
    }

    db.prepare(
      "UPDATE payments SET status = 'declined', transaction_id = ?, decline_reason = ?, updated_at = ? WHERE id = ?"
    ).run(transactionId, declineReason, timestamp, payment.id);
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(timestamp, order.id);

    const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
    for (const item of items) {
      db.prepare("UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?").run(
        item.quantity,
        timestamp,
        item.product_id
      );
    }
    return { ok: true, alreadyProcessed: false, status: "declined" };
  });

  return run(checkoutToken);
}

export function cancelOrder(db, orderId) {
  const run = db.transaction((orderId) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) return { ok: false, reason: "not_found" };
    if (order.status === "cancelled") return { ok: false, reason: "already_cancelled" };
    if (order.status === "fulfilled") return { ok: false, reason: "already_fulfilled" };

    const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(orderId);
    const timestamp = now();
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(timestamp, orderId);
    for (const item of items) {
      db.prepare("UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?").run(
        item.quantity,
        timestamp,
        item.product_id
      );
    }

    const payment = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(orderId);
    if (payment?.status === "succeeded") {
      mockRefund(payment.transaction_id);
      db.prepare("UPDATE payments SET status = 'refunded', updated_at = ? WHERE id = ?").run(timestamp, payment.id);
    } else if (payment?.status === "pending") {
      // Cancelled before the customer ever paid: void the checkout link.
      db.prepare("UPDATE payments SET status = 'declined', decline_reason = 'order_cancelled', updated_at = ? WHERE id = ?").run(
        timestamp,
        payment.id
      );
    }

    return { ok: true, order: { ...order, status: "cancelled", updated_at: timestamp } };
  });

  return run(orderId);
}

/**
 * Admin-only order lifecycle control. "cancelled" delegates to cancelOrder
 * (same stock-restore + idempotency guarantees); "fulfilled" is a pure status
 * flip from "confirmed" with no stock effect (the sale already happened).
 */
export function updateOrderStatus(db, orderId, targetStatus) {
  if (targetStatus === "cancelled") return cancelOrder(db, orderId);
  if (targetStatus !== "fulfilled") {
    return { ok: false, reason: "unsupported_transition" };
  }
  const run = db.transaction((orderId) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) return { ok: false, reason: "not_found" };
    if (order.status !== "confirmed") return { ok: false, reason: `invalid_transition_from_${order.status}` };
    const timestamp = now();
    db.prepare("UPDATE orders SET status = 'fulfilled', updated_at = ? WHERE id = ?").run(timestamp, orderId);
    return { ok: true, order: { ...order, status: "fulfilled", updated_at: timestamp } };
  });
  return run(orderId);
}

function getOrderItemsWithProduct(db, orderId) {
  return db
    .prepare(
      "SELECT p.sku AS sku, p.title AS title, oi.quantity AS quantity, oi.unit_price_cents AS unit_price_cents FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id"
    )
    .all(orderId);
}

function getPaymentForOrder(db, orderId) {
  return db
    .prepare(
      "SELECT status, provider, checkout_token AS checkoutToken, transaction_id AS transactionId, card_last4 AS cardLast4, decline_reason AS declineReason FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(orderId);
}

export function getOrder(db, orderId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return null;
  const items = getOrderItemsWithProduct(db, orderId);
  const payment = getPaymentForOrder(db, orderId);
  return { order, items, payment };
}

export function listOrders(db, { customerRef, status, limit, offset }) {
  const clauses = [];
  const args = [];
  if (customerRef) {
    clauses.push("customer_ref = ?");
    args.push(customerRef);
  }
  if (status) {
    clauses.push("status = ?");
    args.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  args.push(limit, offset);
  const sql = `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const orders = db.prepare(sql).all(...args);
  return orders.map((order) => ({
    ...order,
    items: getOrderItemsWithProduct(db, order.id),
    payment: getPaymentForOrder(db, order.id),
  }));
}
