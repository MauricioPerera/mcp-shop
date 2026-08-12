import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { openDb } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { createApp } from "../src/app.js";
import { registerCustomerCapabilities, registerAdminCapabilities } from "../src/capabilities.js";
import { registerCheckoutRoutes } from "../src/checkoutRoutes.js";
import { signWebhookPayload } from "../src/payments.js";

const AUTH_TOKEN = "test-token-" + randomUUID();
const ADMIN_AUTH_TOKEN = "test-admin-token-" + randomUUID();
const WEBHOOK_SECRET = "test-webhook-secret-" + randomUUID();
let db;
let server;
let baseUrl;

before(async () => {
  db = openDb(":memory:");
  runMigrations(db);
  const app = createMcpExpressApp({ host: "127.0.0.1", allowedHosts: ["127.0.0.1", "localhost"] });
  createApp({
    app,
    db,
    authToken: AUTH_TOKEN,
    serverName: "test-customer",
    registerCapabilities: registerCustomerCapabilities,
    mountPath: "/mcp",
    publicUrl: "http://placeholder.invalid", // only .pathname of checkout_url is used in tests, origin doesn't matter
  });
  createApp({
    app,
    db,
    authToken: ADMIN_AUTH_TOKEN,
    serverName: "test-admin",
    registerCapabilities: registerAdminCapabilities,
    mountPath: "/admin/mcp",
    publicUrl: "http://placeholder.invalid",
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  registerCheckoutRoutes(app, db, { webhookSecret: WEBHOOK_SECRET, webhookUrl: `${baseUrl}/webhooks/payment` });
});

after(() => {
  server.close();
});

beforeEach(() => {
  db.exec("DELETE FROM payments; DELETE FROM order_items; DELETE FROM orders; DELETE FROM products;");
});

function seedProduct(sku, { stock = 10, title = sku, active = 1 } = {}) {
  db.prepare(
    "INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, title, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 'USD', ?, ?, '', 'test', '2026-01-01', '2026-01-01')"
  ).run(randomUUID(), sku, `product://${sku}`, stock, active, title);
}

async function connectClient(path = "/mcp", token = AUTH_TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function textOf(result) {
  return result.content.find((c) => c.type === "text").text;
}

/** Drives the real mock checkout page over HTTP — same request a customer's
 * browser would make after clicking the payment link. */
async function payViaCheckout(checkoutUrl, cardNumber) {
  const path = new URL(checkoutUrl).pathname; // checkout_url is built with publicUrl; only the path is valid against our test server
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `card_number=${encodeURIComponent(cardNumber)}`,
  });
  return response.text();
}

test("rejects requests without a valid bearer token", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
});

test("rejects requests with an invalid bearer token", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer wrong-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
});

test("search_products returns query_matched=true when the query matches", async () => {
  seedProduct("SKU-A", { title: "Auriculares bluetooth" });
  const { client, transport } = await connectClient();
  const result = await client.callTool({ name: "search_products", arguments: { query: "auriculares" } });
  const parsed = JSON.parse(textOf(result));
  assert.equal(parsed.query_matched, true);
  assert.equal(parsed.items.length, 1);
  await transport.terminateSession();
});

test("search_products falls back to the full catalog with query_matched=false when the query matches nothing", async () => {
  seedProduct("SKU-B", { title: "Mouse ergonomico" });
  const { client, transport } = await connectClient();
  const result = await client.callTool({
    name: "search_products",
    arguments: { query: "regalo-que-no-existe" },
  });
  const parsed = JSON.parse(textOf(result));
  assert.equal(parsed.query_matched, false);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].sku, "SKU-B");
  await transport.terminateSession();
});

test("full purchase flow: create_order (pending+link) -> pay at checkout -> webhook confirms -> list_orders -> cancel_order", async () => {
  seedProduct("SKU-C", { stock: 10 });
  const { client, transport } = await connectClient();

  const search = JSON.parse(textOf(await client.callTool({ name: "search_products", arguments: {} })));
  assert.equal(search.items[0].sku, "SKU-C");

  const created = JSON.parse(
    textOf(await client.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-C", quantity: 2 }] } }))
  );
  assert.equal(created.status, "pending");
  assert.equal(created.payment.status, "pending");
  assert.ok(created.payment.checkout_url);

  const stockWhilePending = db.prepare("SELECT stock FROM products WHERE sku = ?").get("SKU-C");
  assert.equal(stockWhilePending.stock, 8, "reserved immediately, before payment resolves");

  await payViaCheckout(created.payment.checkout_url, "4242424242424242");

  const listed = JSON.parse(textOf(await client.callTool({ name: "list_orders", arguments: {} })));
  const listedOrder = listed.items.find((o) => o.order_id === created.order_id);
  assert.equal(listedOrder.status, "confirmed");
  assert.equal(listedOrder.payment.status, "succeeded");

  const cancelled = JSON.parse(
    textOf(await client.callTool({ name: "cancel_order", arguments: { order_id: created.order_id } }))
  );
  assert.equal(cancelled.status, "cancelled");

  const stock = db.prepare("SELECT stock FROM products WHERE sku = ?").get("SKU-C");
  assert.equal(stock.stock, 10);

  await transport.terminateSession();
});

test("declined card at checkout cancels the order and releases the reserved stock", async () => {
  seedProduct("SKU-DECLINE", { stock: 5 });
  const { client, transport } = await connectClient();

  const created = JSON.parse(
    textOf(await client.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-DECLINE", quantity: 1 }] } }))
  );
  assert.equal(created.status, "pending");

  await payViaCheckout(created.payment.checkout_url, "4000000000000002");

  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(created.order_id);
  assert.equal(order.status, "cancelled");
  const stock = db.prepare("SELECT stock FROM products WHERE sku = ?").get("SKU-DECLINE");
  assert.equal(stock.stock, 5);

  await transport.terminateSession();
});

test("webhook rejects a call with an invalid signature", async () => {
  seedProduct("SKU-SIG", { stock: 5 });
  const { client, transport } = await connectClient();
  const created = JSON.parse(
    textOf(await client.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-SIG", quantity: 1 }] } }))
  );
  const checkoutToken = new URL(created.payment.checkout_url).pathname.split("/").pop();

  const response = await fetch(`${baseUrl}/webhooks/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": "deadbeef" },
    body: JSON.stringify({ checkout_token: checkoutToken, status: "approved", transaction_id: "forged" }),
  });
  assert.equal(response.status, 401);

  const order = db.prepare("SELECT status FROM orders WHERE id = ?").get(created.order_id);
  assert.equal(order.status, "pending", "a forged webhook must not confirm the order");

  await transport.terminateSession();
});

test("webhook is idempotent over real HTTP: a duplicate call is acked but doesn't double-process", async () => {
  seedProduct("SKU-DUP", { stock: 5 });
  const { client, transport } = await connectClient();
  const created = JSON.parse(
    textOf(await client.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-DUP", quantity: 1 }] } }))
  );
  const checkoutToken = new URL(created.payment.checkout_url).pathname.split("/").pop();

  const payload = { checkout_token: checkoutToken, status: "approved", transaction_id: "mock_txn_once" };
  const signature = signWebhookPayload(WEBHOOK_SECRET, payload);
  const headers = { "Content-Type": "application/json", "X-Signature": signature };

  const first = await fetch(`${baseUrl}/webhooks/payment`, { method: "POST", headers, body: JSON.stringify(payload) });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, already_processed: false });

  const second = await fetch(`${baseUrl}/webhooks/payment`, { method: "POST", headers, body: JSON.stringify(payload) });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, already_processed: true });

  const stock = db.prepare("SELECT stock FROM products WHERE sku = ?").get("SKU-DUP");
  assert.equal(stock.stock, 4, "still just the single reservation from order creation");

  await transport.terminateSession();
});

test("admin endpoint rejects the customer token and vice versa", async () => {
  const adminWithCustomerToken = await fetch(`${baseUrl}/admin/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(adminWithCustomerToken.status, 401);

  const customerWithAdminToken = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${ADMIN_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(customerWithAdminToken.status, 401);
});

test("customer session cannot see admin tools, admin session cannot see customer's create_order", async () => {
  const { client: customerClient, transport: t1 } = await connectClient("/mcp", AUTH_TOKEN);
  const { tools: customerTools } = await customerClient.listTools();
  assert.ok(!customerTools.some((t) => t.name === "create_product"));
  await t1.terminateSession();

  const { client: adminClient, transport: t2 } = await connectClient("/admin/mcp", ADMIN_AUTH_TOKEN);
  const { tools: adminTools } = await adminClient.listTools();
  assert.ok(adminTools.some((t) => t.name === "create_product"));
  assert.ok(!adminTools.some((t) => t.name === "create_order"));
  await t2.terminateSession();
});

test("admin: create_product -> invisible to customer search while unpublished -> publish -> visible -> set_stock -> update_product", async () => {
  const { client: admin, transport: adminTransport } = await connectClient("/admin/mcp", ADMIN_AUTH_TOKEN);

  const created = JSON.parse(
    textOf(
      await admin.callTool({
        name: "create_product",
        arguments: {
          sku: "SKU-NEW",
          title: "Producto nuevo",
          description: "desc",
          category: "test",
          price_cents: 2500,
          stock: 5,
          published: false,
        },
      })
    )
  );
  assert.equal(created.sku, "SKU-NEW");
  assert.equal(created.published, false);

  // Duplicate SKU is rejected.
  const dup = JSON.parse(
    textOf(
      await admin.callTool({
        name: "create_product",
        arguments: { sku: "SKU-NEW", title: "x", price_cents: 100 },
      })
    )
  );
  assert.equal(dup.error, "sku_exists");

  const { client: customer, transport: customerTransport } = await connectClient("/mcp", AUTH_TOKEN);
  const searchBefore = JSON.parse(
    textOf(await customer.callTool({ name: "search_products", arguments: { query: "Producto nuevo" } }))
  );
  assert.equal(searchBefore.items.length, 0);

  await admin.callTool({ name: "publish_product", arguments: { sku: "SKU-NEW" } });

  const searchAfter = JSON.parse(
    textOf(await customer.callTool({ name: "search_products", arguments: { query: "Producto nuevo" } }))
  );
  assert.equal(searchAfter.items.length, 1);
  assert.equal(searchAfter.items[0].sku, "SKU-NEW");

  await admin.callTool({ name: "set_stock", arguments: { sku: "SKU-NEW", stock: 42 } });
  const updated = JSON.parse(
    textOf(await admin.callTool({ name: "update_product", arguments: { sku: "SKU-NEW", price_cents: 3000 } }))
  );
  assert.equal(updated.price.amount, 30);

  const productRow = db.prepare("SELECT stock, price_cents FROM products WHERE sku = ?").get("SKU-NEW");
  assert.equal(productRow.stock, 42);
  assert.equal(productRow.price_cents, 3000);

  await admin.callTool({ name: "unpublish_product", arguments: { sku: "SKU-NEW" } });
  const searchGone = JSON.parse(
    textOf(await customer.callTool({ name: "search_products", arguments: { query: "Producto nuevo" } }))
  );
  assert.equal(searchGone.items.length, 0);

  await adminTransport.terminateSession();
  await customerTransport.terminateSession();
});

test("admin: update_order_status fulfills a paid order and rejects invalid transitions", async () => {
  seedProduct("SKU-D", { stock: 5 });
  const { client: customer, transport: customerTransport } = await connectClient("/mcp", AUTH_TOKEN);
  const created = JSON.parse(
    textOf(await customer.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-D", quantity: 1 }] } }))
  );
  await payViaCheckout(created.payment.checkout_url, "4242424242424242");

  const { client: admin, transport: adminTransport } = await connectClient("/admin/mcp", ADMIN_AUTH_TOKEN);
  const fulfilled = JSON.parse(
    textOf(await admin.callTool({ name: "update_order_status", arguments: { order_id: created.order_id, status: "fulfilled" } }))
  );
  assert.equal(fulfilled.status, "fulfilled");

  const rejected = JSON.parse(
    textOf(await admin.callTool({ name: "update_order_status", arguments: { order_id: created.order_id, status: "cancelled" } }))
  );
  assert.equal(rejected.error, "already_fulfilled");

  await customerTransport.terminateSession();
  await adminTransport.terminateSession();
});
