import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDb, findProductBySku, createOrder, cancelOrder, confirmPaymentWebhook } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { decideCharge } from "../src/payments.js";

let db;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

function seedProduct(sku, { stock = 10, priceCents = 1000 } = {}) {
  db.prepare(
    "INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, title, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'USD', 1, ?, '', 'test', '2026-01-01', '2026-01-01')"
  ).run(randomUUID(), sku, `product://${sku}`, stock, priceCents, sku);
}

/** Simulates what the mock checkout page does: decide the charge, then feed
 * the result into confirmPaymentWebhook exactly as the webhook route would. */
function payAtCheckout(checkoutToken, cardNumber) {
  const charge = decideCharge(cardNumber);
  return confirmPaymentWebhook(db, {
    checkoutToken,
    approved: charge.approved,
    transactionId: charge.transactionId,
    cardLast4: charge.last4,
    declineReason: charge.declineReason,
  });
}

test("createOrder reserves stock immediately and creates a pending order with a pending payment", () => {
  seedProduct("SKU-A", { stock: 10, priceCents: 1000 });

  const result = createOrder(db, [{ sku: "SKU-A", quantity: 3 }], "cust-1");

  assert.equal(result.ok, true);
  assert.equal(result.order.status, "pending");
  assert.equal(result.order.totalCents, 3000);
  assert.equal(result.order.payment.status, "pending");
  assert.ok(result.order.payment.checkoutToken);
  assert.equal(findProductBySku(db, "SKU-A").stock, 7, "stock reserved at order creation, before payment resolves");
});

test("createOrder rejects and leaves stock untouched when quantity exceeds stock", () => {
  seedProduct("SKU-B", { stock: 2 });

  const result = createOrder(db, [{ sku: "SKU-B", quantity: 5 }]);

  assert.deepEqual(result, { ok: false, reason: "insufficient_stock", sku: "SKU-B" });
  assert.equal(findProductBySku(db, "SKU-B").stock, 2);
});

test("createOrder rejects unknown sku without side effects", () => {
  const result = createOrder(db, [{ sku: "DOES-NOT-EXIST", quantity: 1 }]);
  assert.deepEqual(result, { ok: false, reason: "invalid_sku", sku: "DOES-NOT-EXIST" });
});

test("createOrder rolls back the whole transaction when a later item fails (real ACID, no manual compensation)", () => {
  seedProduct("SKU-C", { stock: 5 });
  seedProduct("SKU-D", { stock: 1 });

  const result = createOrder(db, [
    { sku: "SKU-C", quantity: 3 },
    { sku: "SKU-D", quantity: 5 },
  ]);

  assert.equal(result.ok, false);
  assert.equal(findProductBySku(db, "SKU-C").stock, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
});

test("cancelling a pending order (before payment) restores stock and voids the checkout link", () => {
  seedProduct("SKU-E", { stock: 10, priceCents: 500 });
  const created = createOrder(db, [{ sku: "SKU-E", quantity: 4 }]);
  assert.equal(created.ok, true);

  const cancelled = cancelOrder(db, created.order.orderId);

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.order.status, "cancelled");
  assert.equal(findProductBySku(db, "SKU-E").stock, 10);

  const payment = db.prepare("SELECT status FROM payments WHERE order_id = ?").get(created.order.orderId);
  assert.equal(payment.status, "declined");

  // The now-voided checkout link can't be paid anymore.
  const late = payAtCheckout(created.order.payment.checkoutToken, "4242424242424242");
  assert.deepEqual(late, { ok: true, alreadyProcessed: true, status: "declined" });
});

test("cancelOrder is idempotent: cancelling twice fails the second time without double-restoring stock", () => {
  seedProduct("SKU-F", { stock: 10, priceCents: 500 });
  const created = createOrder(db, [{ sku: "SKU-F", quantity: 2 }]);
  assert.equal(created.ok, true);

  cancelOrder(db, created.order.orderId);
  const second = cancelOrder(db, created.order.orderId);

  assert.deepEqual(second, { ok: false, reason: "already_cancelled" });
  assert.equal(findProductBySku(db, "SKU-F").stock, 10);
});

test("cancelOrder returns not_found for an unknown order id", () => {
  const result = cancelOrder(db, "does-not-exist");
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("webhook confirms an approved payment: order becomes confirmed, stock stays reserved (already decremented)", () => {
  seedProduct("SKU-PAY-OK", { stock: 5, priceCents: 1000 });
  const created = createOrder(db, [{ sku: "SKU-PAY-OK", quantity: 2 }]);
  assert.equal(created.ok, true);

  const result = payAtCheckout(created.order.payment.checkoutToken, "4242424242424242");

  assert.deepEqual(result, { ok: true, alreadyProcessed: false, status: "succeeded" });
  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(created.order.orderId);
  assert.equal(order.status, "confirmed");
  assert.equal(findProductBySku(db, "SKU-PAY-OK").stock, 3, "stock does not change again on confirmation");

  const payment = db.prepare("SELECT status, card_last4 FROM payments WHERE order_id = ?").get(created.order.orderId);
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.card_last4, "4242");
});

for (const [card, expectedReason] of [
  ["4000000000000002", "generic_decline"],
  ["4000000000009995", "insufficient_funds"],
  ["4000000000000069", "expired_card"],
]) {
  test(`webhook declines with ${expectedReason}: order cancelled and stock released`, () => {
    seedProduct("SKU-PAY-DECLINE", { stock: 5, priceCents: 1000 });
    const created = createOrder(db, [{ sku: "SKU-PAY-DECLINE", quantity: 1 }]);
    assert.equal(created.ok, true);
    assert.equal(findProductBySku(db, "SKU-PAY-DECLINE").stock, 4, "reserved at creation");

    const result = payAtCheckout(created.order.payment.checkoutToken, card);

    assert.deepEqual(result, { ok: true, alreadyProcessed: false, status: "declined" });
    const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(created.order.orderId);
    assert.equal(order.status, "cancelled");
    assert.equal(findProductBySku(db, "SKU-PAY-DECLINE").stock, 5, "released back on decline");

    const payment = db.prepare("SELECT status, decline_reason FROM payments WHERE order_id = ?").get(created.order.orderId);
    assert.equal(payment.status, "declined");
    assert.equal(payment.decline_reason, expectedReason);
  });
}

test("confirmPaymentWebhook is idempotent: a duplicate webhook call for an already-resolved payment is a no-op", () => {
  seedProduct("SKU-PAY-DUP", { stock: 5, priceCents: 1000 });
  const created = createOrder(db, [{ sku: "SKU-PAY-DUP", quantity: 1 }]);
  assert.equal(created.ok, true);

  const first = payAtCheckout(created.order.payment.checkoutToken, "4242424242424242");
  assert.equal(first.alreadyProcessed, false);

  const duplicate = confirmPaymentWebhook(db, {
    checkoutToken: created.order.payment.checkoutToken,
    approved: true,
    transactionId: "mock_txn_retry",
    cardLast4: "9999",
  });
  assert.deepEqual(duplicate, { ok: true, alreadyProcessed: true, status: "succeeded" });

  // The retry must not have overwritten the original transaction/card data.
  const payment = db.prepare("SELECT card_last4 FROM payments WHERE order_id = ?").get(created.order.orderId);
  assert.equal(payment.card_last4, "4242");
  assert.equal(findProductBySku(db, "SKU-PAY-DUP").stock, 4, "no double-decrement from the retry");
});

test("confirmPaymentWebhook returns not_found for an unknown checkout token", () => {
  const result = confirmPaymentWebhook(db, {
    checkoutToken: "does-not-exist",
    approved: true,
    transactionId: "x",
    cardLast4: "0000",
  });
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});
