// Concurrency/correctness stress test against a running shop-mcp instance.
// Usage: MCP_URL=https://host/mcp MCP_TOKEN=... node scripts/stress-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = process.env.MCP_URL || "http://127.0.0.1:8796/mcp";
const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) {
  console.error("MCP_TOKEN required");
  process.exit(1);
}

function textOf(result) {
  return result.content.find((c) => c.type === "text").text;
}

async function withClient(fn) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE_URL), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "stress-test", version: "1.0.0" });
  const start = performance.now();
  await client.connect(transport);
  const connectMs = performance.now() - start;
  try {
    return await fn(client, connectMs);
  } finally {
    await transport.terminateSession().catch(() => {});
  }
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(label, latencies, errors, total) {
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`\n=== ${label} ===`);
  console.log(`total: ${total}, ok: ${latencies.length}, errors: ${errors}`);
  if (sorted.length) {
    console.log(
      `latency ms — p50: ${percentile(sorted, 50).toFixed(1)}, p95: ${percentile(sorted, 95).toFixed(1)}, p99: ${percentile(sorted, 99).toFixed(1)}, max: ${sorted[sorted.length - 1].toFixed(1)}`
    );
  }
}

/** Follows the real link+webhook flow: create_order (pending) -> POST to the
 * mock checkout page (same request a customer's browser would make). */
async function buyOne(client, sku) {
  const created = await client.callTool({ name: "create_order", arguments: { items: [{ sku, quantity: 1 }] } });
  const parsed = JSON.parse(textOf(created));
  if (!parsed.payment?.checkout_url) return parsed;

  const checkoutOrigin = new URL(BASE_URL).origin;
  const path = new URL(parsed.payment.checkout_url).pathname;
  await fetch(`${checkoutOrigin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "card_number=4242424242424242",
  });
  return parsed;
}

async function testSearchConcurrency(concurrency) {
  const queries = [null, "audio", "computacion", "hogar", "deportes", "ropa", "juguetes", "cocina", "no-existe-nada"];
  const latencies = [];
  let errors = 0;

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      withClient(async (client) => {
        const query = queries[i % queries.length];
        const t0 = performance.now();
        try {
          const result = await client.callTool({
            name: "search_products",
            arguments: query ? { query, limit: 20 } : { limit: 20 },
          });
          JSON.parse(textOf(result));
          latencies.push(performance.now() - t0);
        } catch (err) {
          errors++;
          console.error(`search error: ${err.message}`);
        }
      })
    )
  );

  summarize(`search_products x${concurrency} concurrent sessions`, latencies, errors, concurrency);
}

async function testConcurrentOversell(sku, stock, attempts) {
  const latencies = [];
  let confirmed = 0;
  let rejectedInsufficient = 0;
  let otherErrors = 0;

  await Promise.all(
    Array.from({ length: attempts }, () =>
      withClient(async (client) => {
        const t0 = performance.now();
        try {
          const parsed = await buyOne(client, sku);
          latencies.push(performance.now() - t0);
          if (parsed.status === "pending") confirmed++;
          else if (parsed.rejected_reason === "insufficient_stock") rejectedInsufficient++;
          else otherErrors++;
        } catch (err) {
          otherErrors++;
          console.error(`order error: ${err.message}`);
        }
      })
    )
  );

  summarize(`create_order oversell attempt: ${attempts} concurrent buyers, stock=${stock}`, latencies, otherErrors, attempts);
  console.log(
    `orders placed: ${confirmed} (expected ${stock}), rejected_insufficient: ${rejectedInsufficient}, other_errors: ${otherErrors}`
  );
  console.log(confirmed === stock ? "PASS: no overselling, exact stock honored" : `FAIL: placed ${confirmed} != stock ${stock}`);
}

async function main() {
  console.log(`Target: ${BASE_URL}`);

  await testSearchConcurrency(40);

  await withClient(async (client) => {
    await client.callTool({ name: "search_products", arguments: { limit: 1 } });
  });

  const sku = process.argv[2] || "SKU-STRESS-PUBLIC";
  const stock = parseInt(process.argv[3] || "15", 10);
  const attempts = parseInt(process.argv[4] || "40", 10);
  await testConcurrentOversell(sku, stock, attempts);

  console.log("\nAll stress phases completed.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
