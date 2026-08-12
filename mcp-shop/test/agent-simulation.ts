/**
 * Simulates a real agent driving the MCP server: connects with the official
 * MCP client SDK (same library a real agent host uses), reads tool/resource
 * descriptions instead of any internal knowledge, and follows resource_uri
 * links returned by tools rather than guessing them. Run against a live
 * server (local `wrangler dev` or the deployed Worker) — not part of `npm test`.
 *
 * Usage:
 *   MCP_URL=http://127.0.0.1:8787/mcp MCP_TOKEN=... npx tsx test/agent-simulation.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";
const token = process.env.MCP_TOKEN;
if (!token) {
  console.error("MCP_TOKEN env var is required");
  process.exit(1);
}

function log(step: string, detail: unknown) {
  console.log(`\n--- ${step} ---`);
  console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
}

function fail(step: string, reason: string): never {
  console.error(`\nFAILED at "${step}": ${reason}`);
  process.exit(1);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) fail("parse tool result", "no text content block");
  return text!;
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "agent-simulation", version: "1.0.0" });
  await client.connect(transport);

  // An agent starts by discovering what it can do — not by reading source code.
  const { tools } = await client.listTools();
  log("tools/list", tools.map((t) => ({ name: t.name, description: t.description })));
  const requiredTools = ["search_products", "create_order", "cancel_order", "list_orders"];
  for (const name of requiredTools) {
    if (!tools.some((t) => t.name === name)) fail("tools/list", `missing tool: ${name}`);
  }

  // "Find me something to buy" — agent searches, doesn't know SKUs up front.
  const searchResult = await client.callTool({ name: "search_products", arguments: { limit: 5 } });
  const searchText = textOf(searchResult as any);
  log("search_products", searchText);
  const search = JSON.parse(searchText) as { items: Array<{ sku: string; resource_uri: string; in_stock: boolean }> };
  const inStock = search.items.find((p) => p.in_stock);
  if (!inStock) fail("search_products", "no in-stock product to buy in catalog — seed one first");

  // Agent follows the resource_uri the tool gave it, doesn't hardcode the URI scheme.
  const productDoc = await client.readResource({ uri: inStock.resource_uri });
  log(`resources/read ${inStock.resource_uri}`, productDoc.contents[0]?.text);
  if (!String(productDoc.contents[0]?.text).includes("type: Product")) {
    fail("resources/read product", "resource content doesn't look like the expected OKF frontmatter");
  }

  // Place an order using only the sku the search step surfaced.
  const orderResult = await client.callTool({
    name: "create_order",
    arguments: { items: [{ sku: inStock.sku, quantity: 1 }], customer_ref: "agent-sim" },
  });
  const orderText = textOf(orderResult as any);
  log("create_order", orderText);
  const order = JSON.parse(orderText) as { order_id?: string; status?: string };
  if (order.status !== "confirmed" || !order.order_id) fail("create_order", "expected a confirmed order with an id");

  // Agent double-checks the order exists via list_orders, filtering by its own customer_ref.
  const listResult = await client.callTool({
    name: "list_orders",
    arguments: { customer_ref: "agent-sim" },
  });
  const listText = textOf(listResult as any);
  log("list_orders", listText);
  const list = JSON.parse(listText) as { items: Array<{ order_id: string; resource_uri: string }> };
  const listedOrder = list.items.find((o) => o.order_id === order.order_id);
  if (!listedOrder) fail("list_orders", "order created above is not visible via list_orders");

  // Read the order resource by following the resource_uri list_orders gave us.
  const orderDoc = await client.readResource({ uri: listedOrder!.resource_uri });
  log(`resources/read ${listedOrder!.resource_uri}`, orderDoc.contents[0]?.text);

  // Agent decides to cancel and expects the stock effect to be implicit (not its job to track).
  const cancelResult = await client.callTool({ name: "cancel_order", arguments: { order_id: order.order_id } });
  const cancelText = textOf(cancelResult as any);
  log("cancel_order", cancelText);
  const cancel = JSON.parse(cancelText) as { status?: string; error?: string | null };
  if (cancel.status !== "cancelled") fail("cancel_order", "expected status cancelled");

  // Idempotency check: a confused agent retrying the same cancel shouldn't corrupt state.
  const secondCancel = await client.callTool({ name: "cancel_order", arguments: { order_id: order.order_id } });
  const secondCancelText = textOf(secondCancel as any);
  log("cancel_order (retry)", secondCancelText);
  const secondCancelParsed = JSON.parse(secondCancelText) as { error?: string };
  if (secondCancelParsed.error !== "already_cancelled") {
    fail("cancel_order retry", "expected already_cancelled error on repeat cancel");
  }

  await client.close();
  console.log("\nAll agent-simulation steps passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
