# mcp-shop (Cloudflare Workers)

MCP-only e-commerce backend on Cloudflare Workers: D1 for storage, one
Durable Object per active MCP session (two DO classes — one for the
sales-agent endpoint, one for the admin endpoint), `agents-sdk`'s
`McpAgent` for the protocol plumbing.

See [`../README.md`](../README.md) for the overall design and
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the shared
architecture writeup (payments, atomicity, admin/customer split). This file
is just the Cloudflare-specific setup.

## Stack

- Cloudflare Workers + Durable Objects (`agents` package's `McpAgent`)
- D1 (SQLite over HTTP) — atomicity via conditional `UPDATE` + manual
  compensation, not real transactions (see architecture doc)
- `@modelcontextprotocol/sdk` (TypeScript)
- Vitest + `@cloudflare/vitest-pool-workers` for tests

## Setup

```bash
npm install
```

Create your own D1 database (the `database_id` in `wrangler.jsonc` is tied to
the original deployment — replace it with yours):

```bash
npx wrangler d1 create shop-db
# paste the returned database_id into wrangler.jsonc
npx wrangler d1 migrations apply shop-db --local   # for local dev
npx wrangler d1 migrations apply shop-db --remote   # for the real deploy, once you have one
```

Copy the local-dev secrets template and fill it in:

```bash
cp .dev.vars.example .dev.vars
# generate each token with:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Also update `wrangler.jsonc`'s `vars.PUBLIC_URL` to your own deployed URL
(the mock checkout links are built from this — a wrong value means the links
in `create_order`'s output won't work over the public internet, though local
dev still works via the `.dev.vars` override).

## Local development

```bash
npm run dev            # wrangler dev, real Durable Object runtime, local D1
npm test                # vitest — unit + full MCP protocol tests, no network
npm run typecheck
```

Seed a product directly against the local D1 for manual testing:

```bash
npx wrangler d1 execute shop-db --local --command \
  "INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, title, description, category, created_at, updated_at) VALUES ('p1','SKU-001','product://SKU-001',10,1999,'USD',1,'Test Product','A thing you can buy','test','2026-01-01','2026-01-01')"
```

## Deploying

```bash
npx wrangler login                       # or set CLOUDFLARE_API_TOKEN
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put ADMIN_AUTH_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler d1 migrations apply shop-db --remote
npx wrangler deploy
```

`wrangler deploy` also applies the Durable Object migration tags in
`wrangler.jsonc` automatically — nothing extra needed there.

## MCP endpoints

| Endpoint | Role | Auth |
|---|---|---|
| `POST/GET/DELETE /mcp` | sales agent | `Authorization: Bearer $AUTH_TOKEN` |
| `POST/GET/DELETE /admin/mcp` | admin agent | `Authorization: Bearer $ADMIN_AUTH_TOKEN` |
| `GET/POST /mock-checkout/:token` | mock payment page (no MCP, no bearer token) | none — it's a page a customer opens |
| `POST /webhooks/payment` | mock payment provider callback | HMAC signature (`X-Signature` header, `WEBHOOK_SECRET`) |

### Sales agent tools (`/mcp`)

| Tool | Description |
|---|---|
| `search_products` | Text/category/stock search. Falls back to the full catalog (`query_matched: false`) instead of an empty list when the query matches nothing. |
| `create_order` | Reserves stock, creates the order `pending`, returns a `checkout_url`. Confirmation happens later via webhook — see architecture doc. |
| `cancel_order` | Cancels a `pending` or `confirmed` order, restores stock, refunds/voids the payment. Idempotent. |
| `list_orders` | Lists orders, optionally filtered by `customer_ref`/`status`. Includes full line items and payment status. |

### Admin tools (`/admin/mcp`)

| Tool | Description |
|---|---|
| `create_product` | Fails on duplicate SKU. `published: false` keeps it invisible to `search_products`. |
| `update_product` | Patches only the fields provided. |
| `set_stock` | Sets stock to an absolute value (restock/correction). |
| `publish_product` / `unpublish_product` | Toggles catalog visibility. No hard delete. |
| `update_order_status` | `confirmed → fulfilled` (no stock effect) or `confirmed → cancelled` (same as `cancel_order`). Any other transition is rejected explicitly. |

Both endpoints also expose `product://{sku}` and `order://{id}` as MCP
resources.

## Project layout

```
src/
  index.ts               Worker entry point — routes /mcp, /admin/mcp,
                          /mock-checkout/:token, /webhooks/payment
  capabilities.ts         wires resources+tools into each McpServer
  db.ts                   all D1 queries — the atomicity-relevant code
  payments.ts              mock charge/refund + HMAC sign/verify
  checkoutRoutes.ts        the mock checkout HTML page + webhook handler
  resources/               product://, order:// resource templates
  tools/                   sales-agent tool implementations
  tools/admin/              admin-only tool implementations
migrations/                D1 schema, applied in order
test/
  db.test.ts               unit tests against a real (Miniflare-simulated) D1
  mcp-tools.test.ts         full MCP protocol tests via SELF.fetch
  agent-simulation.ts       drives a live server with the real MCP client SDK
                            (npm run test:agent — needs MCP_URL/MCP_TOKEN env)
```
