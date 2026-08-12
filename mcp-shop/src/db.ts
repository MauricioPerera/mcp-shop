import { decideCharge, newCheckoutToken, mockRefund } from "./payments";

export interface ProductRow {
  id: string;
  sku: string;
  resource_uri: string;
  stock: number;
  price_cents: number;
  currency: string;
  active: number;
  title: string;
  description: string;
  category: string;
}

export interface OrderRow {
  id: string;
  status: string;
  customer_ref: string | null;
  total_cents: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderItemDetail {
  sku: string;
  title: string;
  quantity: number;
  unit_price_cents: number;
}

const now = () => new Date().toISOString();
const genId = () => crypto.randomUUID();

export async function findProductBySku(db: D1Database, sku: string) {
  return db
    .prepare("SELECT * FROM products WHERE sku = ? AND active = TRUE")
    .bind(sku)
    .first<ProductRow>();
}

/** Unlike findProductBySku, sees unpublished products too — for admin use only. */
export async function findProductBySkuAny(db: D1Database, sku: string) {
  return db.prepare("SELECT * FROM products WHERE sku = ?").bind(sku).first<ProductRow>();
}

export type CreateProductResult = { ok: true; product: ProductRow } | { ok: false; reason: "sku_exists" };

export async function createProduct(
  db: D1Database,
  input: {
    sku: string;
    title: string;
    description?: string;
    category?: string;
    priceCents: number;
    stock?: number;
    active?: boolean;
  }
): Promise<CreateProductResult> {
  if (await findProductBySkuAny(db, input.sku)) return { ok: false, reason: "sku_exists" };
  const timestamp = now();
  await db
    .prepare(
      "INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, title, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      genId(),
      input.sku,
      `product://${input.sku}`,
      input.stock ?? 0,
      input.priceCents,
      input.active ?? true ? 1 : 0,
      input.title,
      input.description ?? "",
      input.category ?? "",
      timestamp,
      timestamp
    )
    .run();
  const product = await findProductBySkuAny(db, input.sku);
  return { ok: true, product: product! };
}

export type ProductMutationResult = { ok: true; product: ProductRow } | { ok: false; reason: "not_found" | "no_fields" };

export async function updateProduct(
  db: D1Database,
  sku: string,
  patch: { title?: string; description?: string; category?: string; priceCents?: number }
): Promise<ProductMutationResult> {
  if (!(await findProductBySkuAny(db, sku))) return { ok: false, reason: "not_found" };
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const [key, column] of [
    ["title", "title"],
    ["description", "description"],
    ["category", "category"],
    ["priceCents", "price_cents"],
  ] as const) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      args.push(value);
    }
  }
  if (fields.length === 0) return { ok: false, reason: "no_fields" };
  fields.push("updated_at = ?");
  args.push(now(), sku);
  await db
    .prepare(`UPDATE products SET ${fields.join(", ")} WHERE sku = ?`)
    .bind(...args)
    .run();
  const product = await findProductBySkuAny(db, sku);
  return { ok: true, product: product! };
}

export async function setStock(db: D1Database, sku: string, stock: number): Promise<ProductMutationResult> {
  if (!(await findProductBySkuAny(db, sku))) return { ok: false, reason: "not_found" };
  await db
    .prepare("UPDATE products SET stock = ?, updated_at = ? WHERE sku = ?")
    .bind(stock, now(), sku)
    .run();
  const product = await findProductBySkuAny(db, sku);
  return { ok: true, product: product! };
}

export async function setPublished(db: D1Database, sku: string, active: boolean): Promise<ProductMutationResult> {
  if (!(await findProductBySkuAny(db, sku))) return { ok: false, reason: "not_found" };
  await db
    .prepare("UPDATE products SET active = ?, updated_at = ? WHERE sku = ?")
    .bind(active ? 1 : 0, now(), sku)
    .run();
  const product = await findProductBySkuAny(db, sku);
  return { ok: true, product: product! };
}

export async function searchProducts(
  db: D1Database,
  opts: { query?: string; category?: string; inStock?: boolean; limit: number; offset: number }
) {
  const clauses = ["active = TRUE"];
  const args: unknown[] = [];
  if (opts.query) {
    clauses.push("(sku LIKE ? OR title LIKE ? OR description LIKE ?)");
    args.push(`%${opts.query}%`, `%${opts.query}%`, `%${opts.query}%`);
  }
  if (opts.category) {
    clauses.push("category = ?");
    args.push(opts.category);
  }
  if (opts.inStock) clauses.push("stock > 0");
  args.push(opts.limit, opts.offset);
  const sql = `SELECT * FROM products WHERE ${clauses.join(" AND ")} ORDER BY sku LIMIT ? OFFSET ?`;
  const { results } = await db.prepare(sql).bind(...args).all<ProductRow>();
  return results;
}

export interface OrderItemInput {
  sku: string;
  quantity: number;
}

export interface PendingPaymentDetail {
  status: "pending";
  checkout_token: string;
}

export type CreateOrderResult =
  | { ok: true; order: OrderRow; items: OrderItemDetail[]; payment: PendingPaymentDetail }
  | { ok: false; reason: "invalid_sku" | "insufficient_stock"; sku: string };

/**
 * Decrements stock per item with a conditional UPDATE (atomic per row in
 * SQLite) and reserves it immediately — before any payment has happened.
 * If any item fails, previously-decremented items are compensated back
 * before returning — D1 has no multi-statement conditional rollback, so
 * partial failure is undone explicitly rather than relying on a transaction.
 * The order is created "pending"; it only becomes "confirmed" later, when
 * confirmPaymentWebhook processes the (asynchronous) payment result.
 */
export async function createOrderTx(
  db: D1Database,
  items: OrderItemInput[],
  customerRef: string | undefined
): Promise<CreateOrderResult> {
  const decremented: { sku: string; quantity: number }[] = [];
  const resolved: { product: ProductRow; quantity: number }[] = [];

  for (const item of items) {
    const product = await findProductBySku(db, item.sku);
    if (!product) {
      await compensate(db, decremented);
      return { ok: false, reason: "invalid_sku", sku: item.sku };
    }
    const result = await db
      .prepare("UPDATE products SET stock = stock - ?, updated_at = ? WHERE sku = ? AND stock >= ?")
      .bind(item.quantity, now(), item.sku, item.quantity)
      .run();
    if (result.meta.changes === 0) {
      await compensate(db, decremented);
      return { ok: false, reason: "insufficient_stock", sku: item.sku };
    }
    decremented.push({ sku: item.sku, quantity: item.quantity });
    resolved.push({ product, quantity: item.quantity });
  }

  const orderId = genId();
  const totalCents = resolved.reduce((sum, r) => sum + r.product.price_cents * r.quantity, 0);
  const currency = resolved[0]?.product.currency ?? "USD";
  const timestamp = now();
  const checkoutToken = newCheckoutToken();

  const itemRows: OrderItemRow[] = resolved.map((r) => ({
    id: genId(),
    order_id: orderId,
    product_id: r.product.id,
    quantity: r.quantity,
    unit_price_cents: r.product.price_cents,
  }));

  await db.batch([
    db
      .prepare(
        "INSERT INTO orders (id, status, customer_ref, total_cents, currency, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?, ?, ?)"
      )
      .bind(orderId, customerRef ?? null, totalCents, currency, timestamp, timestamp),
    ...itemRows.map((it) =>
      db
        .prepare(
          "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(it.id, it.order_id, it.product_id, it.quantity, it.unit_price_cents)
    ),
    db
      .prepare(
        "INSERT INTO payments (id, order_id, amount_cents, currency, status, provider, checkout_token, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 'mock', ?, ?, ?)"
      )
      .bind(genId(), orderId, totalCents, currency, checkoutToken, timestamp, timestamp),
  ]);

  return {
    ok: true,
    order: {
      id: orderId,
      status: "pending",
      customer_ref: customerRef ?? null,
      total_cents: totalCents,
      currency,
      created_at: timestamp,
      updated_at: timestamp,
    },
    items: resolved.map((r) => ({
      sku: r.product.sku,
      title: r.product.title,
      quantity: r.quantity,
      unit_price_cents: r.product.price_cents,
    })),
    payment: { status: "pending", checkout_token: checkoutToken },
  };
}

export async function findPaymentByCheckoutToken(db: D1Database, checkoutToken: string) {
  return db.prepare("SELECT * FROM payments WHERE checkout_token = ?").bind(checkoutToken).first<{
    id: string;
    order_id: string;
    status: string;
    amount_cents: number;
    currency: string;
  }>();
}

export type ConfirmWebhookResult =
  | { ok: true; alreadyProcessed: boolean; status: string }
  | { ok: false; reason: "not_found" };

/**
 * Processes an (already signature-verified) payment webhook. The UPDATE ...
 * WHERE status = 'pending' guard is the idempotency/concurrency-safety
 * mechanism: D1 has no real transactions, so if the same webhook is
 * delivered twice concurrently, only one call's UPDATE actually matches a
 * row (meta.changes === 1) — the other sees 0 changes and reports
 * alreadyProcessed instead of double-applying the effect.
 */
export async function confirmPaymentWebhook(
  db: D1Database,
  {
    checkoutToken,
    approved,
    transactionId,
    cardLast4,
    declineReason,
  }: { checkoutToken: string; approved: boolean; transactionId: string; cardLast4?: string | null; declineReason?: string | null }
): Promise<ConfirmWebhookResult> {
  const payment = await findPaymentByCheckoutToken(db, checkoutToken);
  if (!payment) return { ok: false, reason: "not_found" };
  const timestamp = now();

  if (approved) {
    const result = await db
      .prepare("UPDATE payments SET status = 'succeeded', transaction_id = ?, card_last4 = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(transactionId, cardLast4 ?? null, timestamp, payment.id)
      .run();
    if (result.meta.changes === 0) {
      const current = await findPaymentByCheckoutToken(db, checkoutToken);
      return { ok: true, alreadyProcessed: true, status: current!.status };
    }
    await db.prepare("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?").bind(timestamp, payment.order_id).run();
    return { ok: true, alreadyProcessed: false, status: "succeeded" };
  }

  const result = await db
    .prepare("UPDATE payments SET status = 'declined', transaction_id = ?, decline_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(transactionId, declineReason ?? null, timestamp, payment.id)
    .run();
  if (result.meta.changes === 0) {
    const current = await findPaymentByCheckoutToken(db, checkoutToken);
    return { ok: true, alreadyProcessed: true, status: current!.status };
  }

  const { results: items } = await db
    .prepare("SELECT * FROM order_items WHERE order_id = ?")
    .bind(payment.order_id)
    .all<OrderItemRow>();

  await db.batch([
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(timestamp, payment.order_id),
    ...items.map((it) =>
      db
        .prepare("UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?")
        .bind(it.quantity, timestamp, it.product_id)
    ),
  ]);
  return { ok: true, alreadyProcessed: false, status: "declined" };
}

async function compensate(db: D1Database, decremented: { sku: string; quantity: number }[]) {
  if (decremented.length === 0) return;
  await db.batch(
    decremented.map((d) =>
      db
        .prepare("UPDATE products SET stock = stock + ?, updated_at = ? WHERE sku = ?")
        .bind(d.quantity, now(), d.sku)
    )
  );
}

export type CancelOrderResult =
  | { ok: true; order: OrderRow }
  | { ok: false; reason: "not_found" | "already_cancelled" | "already_fulfilled" };

export async function cancelOrderTx(db: D1Database, orderId: string): Promise<CancelOrderResult> {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<OrderRow>();
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status === "cancelled") return { ok: false, reason: "already_cancelled" };
  if (order.status === "fulfilled") return { ok: false, reason: "already_fulfilled" };

  const { results: items } = await db
    .prepare("SELECT * FROM order_items WHERE order_id = ?")
    .bind(orderId)
    .all<OrderItemRow>();

  const timestamp = now();
  const payment = await db
    .prepare("SELECT * FROM payments WHERE order_id = ?")
    .bind(orderId)
    .first<{ id: string; status: string; transaction_id: string | null }>();

  let paymentUpdate = null;
  if (payment?.status === "succeeded") {
    mockRefund(payment.transaction_id!);
    paymentUpdate = db
      .prepare("UPDATE payments SET status = 'refunded', updated_at = ? WHERE id = ?")
      .bind(timestamp, payment.id);
  } else if (payment?.status === "pending") {
    // Cancelled before the customer ever paid: void the checkout link.
    paymentUpdate = db
      .prepare("UPDATE payments SET status = 'declined', decline_reason = 'order_cancelled', updated_at = ? WHERE id = ?")
      .bind(timestamp, payment.id);
  }

  await db.batch([
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(timestamp, orderId),
    ...items.map((it) =>
      db
        .prepare("UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?")
        .bind(it.quantity, timestamp, it.product_id)
    ),
    ...(paymentUpdate ? [paymentUpdate] : []),
  ]);

  return { ok: true, order: { ...order, status: "cancelled", updated_at: timestamp } };
}

export type UpdateOrderStatusResult =
  | { ok: true; order: OrderRow }
  | { ok: false; reason: "not_found" | "already_cancelled" | "already_fulfilled" | "unsupported_transition" | `invalid_transition_from_${string}` };

/**
 * Admin-only order lifecycle control. "cancelled" delegates to cancelOrderTx
 * (same stock-restore + idempotency guarantees); "fulfilled" is a pure status
 * flip from "confirmed" with no stock effect (the sale already happened).
 */
export async function updateOrderStatus(
  db: D1Database,
  orderId: string,
  targetStatus: "fulfilled" | "cancelled"
): Promise<UpdateOrderStatusResult> {
  if (targetStatus === "cancelled") return cancelOrderTx(db, orderId);

  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<OrderRow>();
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status !== "confirmed") return { ok: false, reason: `invalid_transition_from_${order.status}` };

  const timestamp = now();
  await db
    .prepare("UPDATE orders SET status = 'fulfilled', updated_at = ? WHERE id = ?")
    .bind(timestamp, orderId)
    .run();
  return { ok: true, order: { ...order, status: "fulfilled", updated_at: timestamp } };
}

async function getOrderItemsWithProduct(db: D1Database, orderId: string): Promise<OrderItemDetail[]> {
  const { results } = await db
    .prepare(
      "SELECT p.sku AS sku, p.title AS title, oi.quantity AS quantity, oi.unit_price_cents AS unit_price_cents FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id"
    )
    .bind(orderId)
    .all<OrderItemDetail>();
  return results;
}

interface PaymentRow {
  status: string;
  checkout_token: string | null;
  transaction_id: string | null;
  card_last4: string | null;
  decline_reason: string | null;
}

async function getPaymentForOrder(db: D1Database, orderId: string): Promise<PaymentRow | null> {
  return db
    .prepare(
      "SELECT status, checkout_token, transaction_id, card_last4, decline_reason FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .bind(orderId)
    .first<PaymentRow>();
}

export async function getOrder(db: D1Database, orderId: string) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<OrderRow>();
  if (!order) return null;
  const items = await getOrderItemsWithProduct(db, orderId);
  const payment = await getPaymentForOrder(db, orderId);
  return { order, items, payment };
}

export async function listOrders(
  db: D1Database,
  opts: { customerRef?: string; status?: string; limit: number; offset: number }
) {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (opts.customerRef) {
    clauses.push("customer_ref = ?");
    args.push(opts.customerRef);
  }
  if (opts.status) {
    clauses.push("status = ?");
    args.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  args.push(opts.limit, opts.offset);
  const sql = `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const { results } = await db.prepare(sql).bind(...args).all<OrderRow>();
  const withItems = await Promise.all(
    results.map(async (order) => ({
      ...order,
      items: await getOrderItemsWithProduct(db, order.id),
      payment: await getPaymentForOrder(db, order.id),
    }))
  );
  return withItems;
}
