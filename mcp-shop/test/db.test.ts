import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import migrations from "./migrations";
import {
  createOrderTx,
  cancelOrderTx,
  confirmPaymentWebhook,
  findProductBySku,
  findProductBySkuAny,
  createProduct,
  updateProduct,
  setStock,
  setPublished,
  updateOrderStatus,
} from "../src/db";
import { decideCharge } from "../src/payments";

async function seedProduct(sku: string, stock: number, priceCents = 1999) {
  await env.DB.prepare(
    "INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'USD', TRUE, ?, ?)"
  )
    .bind(crypto.randomUUID(), sku, `product://${sku}`, stock, priceCents, "2026-01-01", "2026-01-01")
    .run();
}

/** Simulates what the mock checkout page does: decide the charge, then feed
 * the result into confirmPaymentWebhook exactly as the webhook route would. */
async function payAtCheckout(checkoutToken: string, cardNumber: string) {
  const charge = decideCharge(cardNumber);
  return confirmPaymentWebhook(env.DB, {
    checkoutToken,
    approved: charge.approved,
    transactionId: charge.transactionId,
    cardLast4: charge.last4,
    declineReason: charge.declineReason ?? null,
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM payments"),
    env.DB.prepare("DELETE FROM order_items"),
    env.DB.prepare("DELETE FROM orders"),
    env.DB.prepare("DELETE FROM products"),
  ]);
});

describe("createOrderTx", () => {
  it("reserves stock immediately and creates a pending order with a pending payment", async () => {
    await seedProduct("SKU-A", 10, 1000);

    const result = await createOrderTx(env.DB, [{ sku: "SKU-A", quantity: 3 }], "cust-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.order.status).toBe("pending");
    expect(result.order.total_cents).toBe(3000);
    expect(result.payment.status).toBe("pending");
    expect(result.payment.checkout_token).toBeTruthy();

    const product = await findProductBySku(env.DB, "SKU-A");
    // Reserved at order creation, before payment resolves.
    expect(product?.stock).toBe(7);
  });

  it("rejects and leaves stock untouched when quantity exceeds stock", async () => {
    await seedProduct("SKU-B", 2, 500);

    const result = await createOrderTx(env.DB, [{ sku: "SKU-B", quantity: 5 }], undefined);

    expect(result).toEqual({ ok: false, reason: "insufficient_stock", sku: "SKU-B" });
    const product = await findProductBySku(env.DB, "SKU-B");
    expect(product?.stock).toBe(2);
  });

  it("rejects unknown sku without side effects", async () => {
    const result = await createOrderTx(env.DB, [{ sku: "DOES-NOT-EXIST", quantity: 1 }], undefined);
    expect(result).toEqual({ ok: false, reason: "invalid_sku", sku: "DOES-NOT-EXIST" });
  });

  it("compensates already-decremented items when a later item in the order fails", async () => {
    await seedProduct("SKU-C", 5, 100);
    await seedProduct("SKU-D", 1, 100);

    const result = await createOrderTx(
      env.DB,
      [
        { sku: "SKU-C", quantity: 3 },
        { sku: "SKU-D", quantity: 5 },
      ],
      undefined
    );

    expect(result.ok).toBe(false);
    const productC = await findProductBySku(env.DB, "SKU-C");
    expect(productC?.stock).toBe(5);
  });
});

describe("cancelOrderTx", () => {
  it("cancelling a pending order (before payment) restores stock and voids the checkout link", async () => {
    await seedProduct("SKU-E", 10, 500);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-E", quantity: 4 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");

    const cancelled = await cancelOrderTx(env.DB, created.order.id);

    expect(cancelled).toEqual({ ok: true, order: expect.objectContaining({ status: "cancelled" }) });
    const product = await findProductBySku(env.DB, "SKU-E");
    expect(product?.stock).toBe(10);

    // The now-voided checkout link can't be paid anymore.
    const late = await payAtCheckout(created.payment.checkout_token, "4242424242424242");
    expect(late).toEqual({ ok: true, alreadyProcessed: true, status: "declined" });
  });

  it("is idempotent: cancelling twice fails the second time without double-restoring stock", async () => {
    await seedProduct("SKU-F", 10, 500);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-F", quantity: 2 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");

    await cancelOrderTx(env.DB, created.order.id);
    const secondCancel = await cancelOrderTx(env.DB, created.order.id);

    expect(secondCancel).toEqual({ ok: false, reason: "already_cancelled" });
    const product = await findProductBySku(env.DB, "SKU-F");
    expect(product?.stock).toBe(10);
  });

  it("returns not_found for an unknown order id", async () => {
    const result = await cancelOrderTx(env.DB, "does-not-exist");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("admin: createProduct/updateProduct/setStock/setPublished", () => {
  it("creates a product and rejects a duplicate sku", async () => {
    const created = await createProduct(env.DB, { sku: "SKU-NEW", title: "Nuevo", priceCents: 1500, stock: 5 });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected ok");
    expect(created.product.active).toBe(1);

    const dup = await createProduct(env.DB, { sku: "SKU-NEW", title: "x", priceCents: 100 });
    expect(dup).toEqual({ ok: false, reason: "sku_exists" });
  });

  it("creates an unpublished product invisible to findProductBySku but visible to findProductBySkuAny", async () => {
    await createProduct(env.DB, { sku: "SKU-HIDDEN", title: "Oculto", priceCents: 100, active: false });
    expect(await findProductBySku(env.DB, "SKU-HIDDEN")).toBeNull();
    const any = await findProductBySkuAny(env.DB, "SKU-HIDDEN");
    expect(any?.active).toBe(0);
  });

  it("updateProduct only patches provided fields and rejects unknown sku / empty patch", async () => {
    await createProduct(env.DB, { sku: "SKU-EDIT", title: "Original", priceCents: 1000 });
    const updated = await updateProduct(env.DB, "SKU-EDIT", { priceCents: 2000 });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("expected ok");
    expect(updated.product.price_cents).toBe(2000);
    expect(updated.product.title).toBe("Original");

    expect(await updateProduct(env.DB, "DOES-NOT-EXIST", { title: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(await updateProduct(env.DB, "SKU-EDIT", {})).toEqual({ ok: false, reason: "no_fields" });
  });

  it("setStock sets an absolute value and setPublished toggles visibility", async () => {
    await createProduct(env.DB, { sku: "SKU-TOGGLE", title: "T", priceCents: 100, stock: 1, active: true });

    await setStock(env.DB, "SKU-TOGGLE", 42);
    expect((await findProductBySkuAny(env.DB, "SKU-TOGGLE"))?.stock).toBe(42);

    await setPublished(env.DB, "SKU-TOGGLE", false);
    expect(await findProductBySku(env.DB, "SKU-TOGGLE")).toBeNull();

    await setPublished(env.DB, "SKU-TOGGLE", true);
    expect((await findProductBySku(env.DB, "SKU-TOGGLE"))?.sku).toBe("SKU-TOGGLE");
  });
});

describe("admin: updateOrderStatus", () => {
  it("fulfills a paid order without touching stock again", async () => {
    await seedProduct("SKU-G", 10, 500);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-G", quantity: 2 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");
    await payAtCheckout(created.payment.checkout_token, "4242424242424242");

    const fulfilled = await updateOrderStatus(env.DB, created.order.id, "fulfilled");
    expect(fulfilled).toEqual({ ok: true, order: expect.objectContaining({ status: "fulfilled" }) });

    const product = await findProductBySku(env.DB, "SKU-G");
    expect(product?.stock).toBe(8);
  });

  it("rejects fulfilling a pending (unpaid) order", async () => {
    await seedProduct("SKU-H", 10, 500);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-H", quantity: 1 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");

    const result = await updateOrderStatus(env.DB, created.order.id, "fulfilled");
    expect(result).toEqual({ ok: false, reason: "invalid_transition_from_pending" });
  });

  it("rejects fulfilling an order that is already fulfilled", async () => {
    await seedProduct("SKU-H2", 10, 500);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-H2", quantity: 1 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");
    await payAtCheckout(created.payment.checkout_token, "4242424242424242");

    await updateOrderStatus(env.DB, created.order.id, "fulfilled");
    const second = await updateOrderStatus(env.DB, created.order.id, "fulfilled");
    expect(second).toEqual({ ok: false, reason: "invalid_transition_from_fulfilled" });
  });

  it("cancelled target delegates to cancelOrderTx (restores stock)", async () => {
    await seedProduct("SKU-I", 10, 500);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-I", quantity: 3 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");

    const cancelled = await updateOrderStatus(env.DB, created.order.id, "cancelled");
    expect(cancelled).toEqual({ ok: true, order: expect.objectContaining({ status: "cancelled" }) });
    const product = await findProductBySku(env.DB, "SKU-I");
    expect(product?.stock).toBe(10);
  });
});

describe("mock payment gateway (webhook-confirmed)", () => {
  it("webhook confirms an approved payment: order becomes confirmed, stock stays reserved", async () => {
    await seedProduct("SKU-PAY-OK", 5, 1000);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-PAY-OK", quantity: 2 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");

    const result = await payAtCheckout(created.payment.checkout_token, "4242424242424242");

    expect(result).toEqual({ ok: true, alreadyProcessed: false, status: "succeeded" });
    const order = await env.DB.prepare("SELECT status FROM orders WHERE id = ?").bind(created.order.id).first();
    expect(order).toEqual({ status: "confirmed" });
    const product = await findProductBySku(env.DB, "SKU-PAY-OK");
    // No second decrement on confirmation.
    expect(product?.stock).toBe(3);

    const payment = await env.DB.prepare("SELECT status, card_last4 FROM payments WHERE order_id = ?")
      .bind(created.order.id)
      .first();
    expect(payment).toEqual({ status: "succeeded", card_last4: "4242" });
  });

  for (const [card, expectedReason] of [
    ["4000000000000002", "generic_decline"],
    ["4000000000009995", "insufficient_funds"],
    ["4000000000000069", "expired_card"],
  ] as const) {
    it(`webhook declines with ${expectedReason}: order cancelled and stock released`, async () => {
      await seedProduct("SKU-PAY-DECLINE", 5, 1000);
      const created = await createOrderTx(env.DB, [{ sku: "SKU-PAY-DECLINE", quantity: 1 }], undefined);
      if (!created.ok) throw new Error("expected order to be created");

      const result = await payAtCheckout(created.payment.checkout_token, card);

      expect(result).toEqual({ ok: true, alreadyProcessed: false, status: "declined" });
      const order = await env.DB.prepare("SELECT status FROM orders WHERE id = ?").bind(created.order.id).first();
      expect(order).toEqual({ status: "cancelled" });
      const product = await findProductBySku(env.DB, "SKU-PAY-DECLINE");
      // Released back on decline.
      expect(product?.stock).toBe(5);

      const payment = await env.DB.prepare("SELECT status, decline_reason FROM payments WHERE order_id = ?")
        .bind(created.order.id)
        .first();
      expect(payment).toEqual({ status: "declined", decline_reason: expectedReason });
    });
  }

  it("is idempotent: a duplicate webhook for an already-resolved payment is a no-op", async () => {
    await seedProduct("SKU-PAY-DUP", 5, 1000);
    const created = await createOrderTx(env.DB, [{ sku: "SKU-PAY-DUP", quantity: 1 }], undefined);
    if (!created.ok) throw new Error("expected order to be created");

    const first = await payAtCheckout(created.payment.checkout_token, "4242424242424242");
    expect(first.ok && !first.alreadyProcessed).toBe(true);

    const duplicate = await confirmPaymentWebhook(env.DB, {
      checkoutToken: created.payment.checkout_token,
      approved: true,
      transactionId: "mock_txn_retry",
      cardLast4: "9999",
    });
    expect(duplicate).toEqual({ ok: true, alreadyProcessed: true, status: "succeeded" });

    const payment = await env.DB.prepare("SELECT card_last4 FROM payments WHERE order_id = ?")
      .bind(created.order.id)
      .first();
    expect(payment).toEqual({ card_last4: "4242" });
    const product = await findProductBySku(env.DB, "SKU-PAY-DUP");
    // No double-decrement from the retry.
    expect(product?.stock).toBe(4);
  });

  it("returns not_found for an unknown checkout token", async () => {
    const result = await confirmPaymentWebhook(env.DB, {
      checkoutToken: "does-not-exist",
      approved: true,
      transactionId: "x",
      cardLast4: "0000",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
