# mcp-shop

An e-commerce backend exposed entirely through **MCP (Model Context Protocol)**
instead of a REST API or an admin UI — the idea being "WooCommerce, but the
only client is an AI agent." A sales agent and an admin agent talk to two
separate, independently authenticated MCP endpoints; there is no human-facing
storefront.

Two independent implementations of the same design live in this repo, to
prove the design is genuinely platform-portable:

| | [`mcp-shop/`](./mcp-shop) | [`mcp-shop-vps/`](./mcp-shop-vps) |
|---|---|---|
| Runtime | Cloudflare Workers | Node.js (plain `http`/Express) |
| Database | D1 (SQLite over HTTP) | `better-sqlite3` (real file, real transactions) |
| State | Durable Objects (one per MCP session) | in-process session map |
| Process model | Serverless, no compensating transactions needed for atomicity beyond the ones below | Long-running process, PM2 |
| Atomicity | Conditional `UPDATE ... WHERE` + manual compensation (D1 has no multi-statement transactions) | Real `BEGIN/COMMIT/ROLLBACK` |

Both expose the *identical* MCP surface (same tools, same resources, same
JSON shapes) — see either subfolder's README for the full reference. This
top-level doc covers what's shared: the design, not the deploy target.

## Why two MCP endpoints, not one

- **`/mcp`** — the sales agent. `search_products`, `create_order`,
  `cancel_order`, `list_orders`. Bearer token A.
- **`/admin/mcp`** — the catalog/ops agent. `create_product`,
  `update_product`, `set_stock`, `publish_product`, `unpublish_product`,
  `update_order_status`. Bearer token B (different from token A — a session
  authenticated as "sales" cannot even *see* the admin tools in `tools/list`,
  let alone call them).

This mirrors a real store: the person restocking inventory and the person
answering a customer's chat are not the same actor and shouldn't have the
same permissions. It also means you can point two different agents (or two
different LLMs) at the two endpoints and get real separation of duties
without writing any authorization logic inside the tool handlers themselves —
the boundary is the HTTP endpoint + token.

## Payments: a real link+webhook flow, fully mocked

`create_order` doesn't take a card number. It reserves stock, creates the
order as `pending`, and returns a `checkout_url` — a real, clickable link to
a real HTML page hosted by the same server. The order only becomes
`confirmed` later, asynchronously, when that page's payment result is
delivered to a `POST /webhooks/payment` endpoint, HMAC-signed, exactly like
Stripe or MercadoPago would deliver it.

This is **not** a real payment processor — there are no credentials, no
network calls to a real gateway, and no money moves. It's a stand-in that
gets the *architecture* right (async confirmation, idempotent webhook
handling, signature verification, stock reserved-not-charged) so that
swapping in a real provider later is a matter of replacing one module
(`payments.ts` / `payments.js`), not redesigning the order lifecycle.

Test cards (same convention as Stripe test mode):

| Card number | Result |
|---|---|
| `4242424242424242` | approved |
| `4000000000000002` | declined — generic |
| `4000000000009995` | declined — insufficient funds |
| `4000000000000069` | declined — expired card |
| anything else | approved |

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design
writeup — idempotency, the concurrency guard, and the one honest
simplification (signature verification over a canonical string instead of
raw request bytes, and why).

## What's genuinely tested, not just claimed

- Real ACID transactions (VPS) / conditional-update-with-compensation (D1)
  verified under **actual concurrent load**: 200 simultaneous buyers against
  a SKU with stock=20 → exactly 20 confirmed, 180 correctly rejected, zero
  overselling, verified against the database independently of what the tools
  reported.
- The full purchase flow (search → checkout link → real HTTP POST to the mock
  checkout page → webhook fires → order confirms) driven end-to-end over real
  HTTP in the test suite, not mocked.
- Two independent AI agents actually talking to this over MCP — a
  sales-agent role and an admin role, run against poolside (poolside.ai) —
  confirmed against the database, not just the agent's own report of success.

## Quick start

Pick one:

- **Cloudflare**: [`mcp-shop/README.md`](./mcp-shop/README.md)
- **VPS / any Node host**: [`mcp-shop-vps/README.md`](./mcp-shop-vps/README.md)

## License

MIT — see [`LICENSE`](./LICENSE).
