import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import migrations from "./migrations";

async function seedProduct(sku: string, opts: { title?: string; description?: string; stock?: number } = {}) {
  await env.DB.prepare(
    "INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, title, description, category, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, 'USD', TRUE, ?, ?, 'test', '2026-01-01', '2026-01-01')"
  )
    .bind(crypto.randomUUID(), sku, `product://${sku}`, opts.stock ?? 10, opts.title ?? sku, opts.description ?? "")
    .run();
}

async function connectClient(path = "/mcp", token = env.AUTH_TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://shop.test${path}`), {
    fetch: SELF.fetch.bind(SELF),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/**
 * client.close() calls transport.close(), which hard-aborts the open background
 * SSE stream (AbortController.abort()) instead of ending it gracefully. Under
 * vitest-pool-workers' in-process SELF.fetch, that abort surfaces as an unhandled
 * rejection after assertions already passed. transport.terminateSession() sends
 * a real MCP `DELETE` instead: the server runs its own graceful stream.close()
 * (see webStandardStreamableHttp.js close()), so the client's reader sees a
 * normal stream end rather than an abort. Do this instead of client.close().
 */
async function disconnect(transport: StreamableHTTPClientTransport) {
  await transport.terminateSession();
}

function textOf(result: any): string {
  return result.content.find((c: any) => c.type === "text").text;
}

/** Drives the real mock checkout page over SELF.fetch — same request a
 * customer's browser would make after clicking the payment link. */
async function payViaCheckout(checkoutUrl: string, cardNumber: string) {
  const path = new URL(checkoutUrl).pathname; // checkout_url is built with PUBLIC_URL; only the path is valid against SELF
  const response = await SELF.fetch(`http://shop.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `card_number=${encodeURIComponent(cardNumber)}`,
  });
  return response.text();
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

describe("search_products via MCP protocol", () => {
  it("rejects requests without a valid bearer token", async () => {
    const response = await SELF.fetch("http://shop.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("returns query_matched=true when the query matches products", async () => {
    await seedProduct("SKU-A", { title: "Auriculares bluetooth" });
    const { client, transport } = await connectClient();
    const result = await client.callTool({ name: "search_products", arguments: { query: "auriculares" } });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.query_matched).toBe(true);
    expect(parsed.items).toHaveLength(1);
    await disconnect(transport);
  });

  it("falls back to the full catalog with query_matched=false when the query matches nothing", async () => {
    await seedProduct("SKU-B", { title: "Mouse ergonomico" });
    const { client, transport } = await connectClient();
    const result = await client.callTool({
      name: "search_products",
      arguments: { query: "regalo-que-no-existe-en-ningun-producto" },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.query_matched).toBe(false);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].sku).toBe("SKU-B");
    await disconnect(transport);
  });

  it("fallback still respects category and in_stock filters", async () => {
    await seedProduct("SKU-C", { title: "Producto agotado", stock: 0 });
    await seedProduct("SKU-D", { title: "Producto disponible", stock: 5 });
    const { client, transport } = await connectClient();
    const result = await client.callTool({
      name: "search_products",
      arguments: { query: "no-matchea-nada", in_stock: true },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.query_matched).toBe(false);
    expect(parsed.items.map((i: any) => i.sku)).toEqual(["SKU-D"]);
    await disconnect(transport);
  });
});

describe("admin endpoint isolation", () => {
  it("admin endpoint rejects the customer token and vice versa", async () => {
    const adminWithCustomerToken = await SELF.fetch("http://shop.test/admin/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${env.AUTH_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(adminWithCustomerToken.status).toBe(401);

    const customerWithAdminToken = await SELF.fetch("http://shop.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${env.ADMIN_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(customerWithAdminToken.status).toBe(401);
  });

  it("customer session cannot see admin tools; admin session cannot see create_order", async () => {
    const { client: customer, transport: t1 } = await connectClient("/mcp", env.AUTH_TOKEN);
    const { tools: customerTools } = await customer.listTools();
    expect(customerTools.some((t) => t.name === "create_product")).toBe(false);
    await disconnect(t1);

    const { client: admin, transport: t2 } = await connectClient("/admin/mcp", env.ADMIN_AUTH_TOKEN);
    const { tools: adminTools } = await admin.listTools();
    expect(adminTools.some((t) => t.name === "create_product")).toBe(true);
    expect(adminTools.some((t) => t.name === "create_order")).toBe(false);
    await disconnect(t2);
  });
});

describe("admin product/order management via MCP protocol", () => {
  it("create_product (unpublished) -> invisible to search -> publish -> visible -> set_stock -> update_product", async () => {
    const { client: admin, transport: adminTransport } = await connectClient("/admin/mcp", env.ADMIN_AUTH_TOKEN);

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
    expect(created.sku).toBe("SKU-NEW");
    expect(created.published).toBe(false);

    const { client: customer, transport: customerTransport } = await connectClient("/mcp", env.AUTH_TOKEN);
    const before = JSON.parse(
      textOf(await customer.callTool({ name: "search_products", arguments: { query: "Producto nuevo" } }))
    );
    expect(before.items).toHaveLength(0);

    await admin.callTool({ name: "publish_product", arguments: { sku: "SKU-NEW" } });
    const after = JSON.parse(
      textOf(await customer.callTool({ name: "search_products", arguments: { query: "Producto nuevo" } }))
    );
    expect(after.items).toHaveLength(1);

    await admin.callTool({ name: "set_stock", arguments: { sku: "SKU-NEW", stock: 42 } });
    const updated = JSON.parse(
      textOf(await admin.callTool({ name: "update_product", arguments: { sku: "SKU-NEW", price_cents: 3000 } }))
    );
    expect(updated.price.amount).toBe(30);

    const row = await env.DB.prepare("SELECT stock, price_cents FROM products WHERE sku = ?").bind("SKU-NEW").first<{
      stock: number;
      price_cents: number;
    }>();
    expect(row?.stock).toBe(42);
    expect(row?.price_cents).toBe(3000);

    await disconnect(adminTransport);
    await disconnect(customerTransport);
  });

  it("update_order_status fulfills a paid order and rejects invalid transitions", async () => {
    await seedProduct("SKU-E2", { stock: 5 });
    const { client: customer, transport: customerTransport } = await connectClient("/mcp", env.AUTH_TOKEN);
    const created = JSON.parse(
      textOf(await customer.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-E2", quantity: 1 }] } }))
    );
    await payViaCheckout(created.payment.checkout_url, "4242424242424242");

    const { client: admin, transport: adminTransport } = await connectClient("/admin/mcp", env.ADMIN_AUTH_TOKEN);
    const fulfilled = JSON.parse(
      textOf(
        await admin.callTool({ name: "update_order_status", arguments: { order_id: created.order_id, status: "fulfilled" } })
      )
    );
    expect(fulfilled.status).toBe("fulfilled");

    const rejected = JSON.parse(
      textOf(
        await admin.callTool({ name: "update_order_status", arguments: { order_id: created.order_id, status: "cancelled" } })
      )
    );
    expect(rejected.error).toBe("already_fulfilled");

    await disconnect(customerTransport);
    await disconnect(adminTransport);
  });
});

describe("mock payment gateway (link + async webhook) via MCP protocol", () => {
  it("create_order returns pending+link; paying at checkout confirms via webhook; cancel refunds", async () => {
    await seedProduct("SKU-PAY", { stock: 5 });
    const { client, transport } = await connectClient();

    const created = JSON.parse(
      textOf(await client.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-PAY", quantity: 1 }] } }))
    );
    expect(created.status).toBe("pending");
    expect(created.payment.status).toBe("pending");
    expect(created.payment.checkout_url).toBeTruthy();

    const stockWhilePending = await env.DB.prepare("SELECT stock FROM products WHERE sku = ?")
      .bind("SKU-PAY")
      .first<{ stock: number }>();
    expect(stockWhilePending?.stock).toBe(4);

    await payViaCheckout(created.payment.checkout_url, "4242424242424242");

    const listed = JSON.parse(textOf(await client.callTool({ name: "list_orders", arguments: {} })));
    const listedOrder = listed.items.find((o: any) => o.order_id === created.order_id);
    expect(listedOrder.status).toBe("confirmed");
    expect(listedOrder.payment.status).toBe("succeeded");

    const cancelled = JSON.parse(
      textOf(await client.callTool({ name: "cancel_order", arguments: { order_id: created.order_id } }))
    );
    expect(cancelled.status).toBe("cancelled");

    const orderResource = await client.readResource({ uri: `order://${created.order_id}` });
    const orderData = JSON.parse((orderResource.contents[0] as { text: string }).text);
    expect(orderData.payment.status).toBe("refunded");

    const stockAfterCancel = await env.DB.prepare("SELECT stock FROM products WHERE sku = ?")
      .bind("SKU-PAY")
      .first<{ stock: number }>();
    expect(stockAfterCancel?.stock).toBe(5);

    await disconnect(transport);
  });

  it("declined card at checkout cancels the order and releases the reserved stock", async () => {
    await seedProduct("SKU-PAY-DECLINE", { stock: 5 });
    const { client, transport } = await connectClient();

    const created = JSON.parse(
      textOf(
        await client.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-PAY-DECLINE", quantity: 1 }] } })
      )
    );

    await payViaCheckout(created.payment.checkout_url, "4000000000000002");

    const order = await env.DB.prepare("SELECT status FROM orders WHERE id = ?").bind(created.order_id).first();
    expect(order).toEqual({ status: "cancelled" });
    const stock = await env.DB.prepare("SELECT stock FROM products WHERE sku = ?")
      .bind("SKU-PAY-DECLINE")
      .first<{ stock: number }>();
    expect(stock?.stock).toBe(5);

    await disconnect(transport);
  });

  it("webhook rejects a call with an invalid signature and does not confirm the order", async () => {
    await seedProduct("SKU-PAY-SIG", { stock: 5 });
    const { client, transport } = await connectClient();
    const created = JSON.parse(
      textOf(
        await client.callTool({ name: "create_order", arguments: { items: [{ sku: "SKU-PAY-SIG", quantity: 1 }] } })
      )
    );
    const checkoutToken = new URL(created.payment.checkout_url).pathname.split("/").pop();

    const response = await SELF.fetch("http://shop.test/webhooks/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": "deadbeef" },
      body: JSON.stringify({ checkout_token: checkoutToken, status: "approved", transaction_id: "forged" }),
    });
    expect(response.status).toBe(401);

    const order = await env.DB.prepare("SELECT status FROM orders WHERE id = ?").bind(created.order_id).first();
    expect(order).toEqual({ status: "pending" });

    await disconnect(transport);
  });
});
