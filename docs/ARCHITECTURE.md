# Architecture

This covers design decisions shared by both implementations
([`mcp-shop/`](../mcp-shop) and [`mcp-shop-vps/`](../mcp-shop-vps)). Anything
platform-specific (D1 vs SQLite, Durable Objects vs an in-process session
map) lives in each subfolder's own README.

## Data model

```
products (sku unique, active flag = published/unpublished, stock, price_cents, title, description, category)
orders   (status: pending | confirmed | cancelled | fulfilled)
order_items (order_id, product_id, quantity, unit_price_cents — price snapshot at purchase time)
payments (order_id, status: pending | succeeded | declined | refunded, checkout_token unique, transaction_id, card_last4, decline_reason)
```

`order_items.unit_price_cents` is a snapshot, not a join to the live product
price — an order's total doesn't change if the product's price changes
later.

## Resources vs. tools

Products and orders are exposed both as MCP **resources**
(`product://{sku}`, `order://{id}`, OKF-inspired frontmatter + markdown for
products) and as data embedded directly in **tool** outputs
(`search_products` returns full title/description/price/stock inline,
`create_order`/`list_orders` return full line-item detail).

This duplication is deliberate, not an oversight. In practice, most MCP
clients only wire *tools* into an agent's action space — resources require
the host to explicitly support browsing/reading them, and many don't. This
was verified directly: running a real agent (poolside) against this server
showed it never called `resources/read` even once across two full purchase
conversations, despite `resource_uri` being present in every tool response.
So: nothing an agent needs to *act* is resource-only. Resources exist for
MCP-native clients that do support them (Claude Desktop, hand-written test
clients) and for future-proofing.

## Admin/customer separation

Two MCP endpoints, two bearer tokens, two distinct sets of registered tools —
see the root README for the "why." Concretely: a session authenticated with
the sales token gets a `McpServer` instance where `registerAdminTools` was
never called, so `create_product` etc. don't exist for it, not just
"exist but return 403." `tools/list` for that session genuinely doesn't
include them.

## Stock reservation and atomicity

Both implementations decrement stock **at order-creation time** (when the
checkout link is generated), not when payment is confirmed. This prevents
overselling while a customer is on the checkout page, at the cost of no
automatic release if they abandon it — there's no expiry/TTL sweep for
abandoned pending orders in either implementation. A cron/scheduled job that
cancels `pending` orders older than N minutes would be the natural next
addition.

**VPS**: `better-sqlite3`'s `db.transaction()` gives real, synchronous ACID
transactions. A failed item throws and the whole transaction rolls back
automatically — no manual bookkeeping.

**Cloudflare (D1)**: D1 has no multi-statement conditional transactions.
Every stock decrement is its own atomic conditional `UPDATE products SET
stock = stock - ? WHERE sku = ? AND stock >= ?` (atomic per-row in SQLite),
and if a *later* item in a multi-item order fails, the items already
decremented are compensated back explicitly (`compensate()` in `db.ts`)
before returning the error. This was verified under real concurrent load —
200 simultaneous buyers against stock=20 produced exactly 20 confirmed
orders, not 19 or 21.

## The payment webhook

`create_order` returns a `checkout_url` pointing at a real page
(`GET /mock-checkout/:token`) served by the same app. Submitting that page's
form (`POST /mock-checkout/:token`) decides approve/decline based on the
card number, then the *result* is delivered to `POST /webhooks/payment` —
the same public, unauthenticated-by-bearer-token endpoint a real payment
provider would call.

### Idempotency

Providers retry webhook deliveries. Both implementations guard against
double-processing:

- **VPS**: the whole thing runs inside one `db.transaction()`, so a
  read-then-check-then-write is safe — SQLite serializes it.
- **Cloudflare**: no such transaction exists, so the guard is a conditional
  `UPDATE payments SET status = 'succeeded' WHERE id = ? AND status =
  'pending'` — if two copies of the same webhook race, only one's `UPDATE`
  actually matches a row (`meta.changes === 1`); the other sees 0 changes and
  reports `alreadyProcessed: true` instead of confirming the order twice.

Verified with a real duplicate HTTP POST to `/webhooks/payment` in the test
suite: first call confirms, second call is acked with `already_processed:
true` and doesn't touch stock again.

### Signature verification — the one honest simplification

Real providers (Stripe, MercadoPago) sign the **raw request body bytes**.
Verifying that requires capturing the bytes before any JSON body parser
touches the request — both Express (`express.json()`) and this repo's
Cloudflare Worker parse the body before the webhook handler runs, so raw
bytes aren't available by the time signature verification happens.

Instead, both implementations sign a canonical string of three known fields
(`checkout_token.status.transaction_id`) with HMAC-SHA256. This is still a
real signature — a forged call without the shared secret is rejected with
`401` (tested directly) — it's just not byte-for-byte what a real provider's
official verification helper expects. **When wiring in a real provider, use
their SDK's verification helper** (e.g. Stripe's
`stripe.webhooks.constructEvent`), which handles raw-body capture correctly;
don't reuse this repo's `signWebhookPayload`/`verifyWebhookSignature` as-is.

### Why the mock checkout page self-calls the webhook differently per platform

On the VPS, the checkout page's POST handler makes a real loopback HTTP
request to `http://127.0.0.1:PORT/webhooks/payment` — cheap, reliable, same
process.

On Cloudflare, a Worker fetching its own public URL routes back out through
Cloudflare's edge for no benefit (it's the same isolate either way), so the
checkout handler calls the webhook-processing function directly in-process
instead — including computing and verifying the HMAC signature, so the exact
same verification code path still runs. The real `POST /webhooks/payment`
route (what an actual provider would call) is unaffected either way.

## Order lifecycle

```
pending ──(webhook: approved)──► confirmed ──(admin: fulfilled)──► fulfilled
   │                                  │
   │ (webhook: declined,              │ (cancel_order / admin cancel)
   │  or cancelled before payment)    ▼
   └─────────────────────────────► cancelled
```

- `cancel_order` (customer-facing) works on `pending` or `confirmed` orders.
  Cancelling a `pending` order voids its checkout link (marks the payment
  `declined`, reason `order_cancelled`) so a stale link can't be paid later.
  Cancelling a `confirmed` order triggers a mock refund.
- `update_order_status` (admin-only) allows `confirmed → fulfilled` (pure
  status flip, no stock effect — the sale already happened) and
  `confirmed → cancelled` (delegates to the same cancel logic). Any other
  transition is rejected explicitly rather than silently no-op'd.

## What's out of scope (known gaps)

Documented rather than silently missing:

- No shipping address or shipping cost.
- No tax calculation.
- No coupons/discounts.
- No structured product variants (size/color) — imported WooCommerce
  variations are flattened into separate SKUs with the attribute baked into
  the title string.
- No abandoned-checkout expiry job (see "Stock reservation" above).
- No hard delete for products — `unpublish_product` is the only removal
  path, by design (keeps order history intact).
