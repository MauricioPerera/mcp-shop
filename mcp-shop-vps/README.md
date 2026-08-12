# mcp-shop-vps (Node.js)

Same MCP e-commerce backend as [`../mcp-shop`](../mcp-shop), running as a
plain Node process instead of on Cloudflare — one Express app, `better-sqlite3`
for storage, real ACID transactions.

See [`../README.md`](../README.md) for the overall design and
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the shared
architecture writeup (payments, atomicity, admin/customer split). This file
is just the Node/VPS-specific setup.

## Stack

- Node.js ≥ 20.6 (uses `node --env-file`)
- Express (only for routing/body-parsing — no framework magic)
- `better-sqlite3` — real synchronous transactions, no manual compensation
  needed anywhere in `db.js`
- `@modelcontextprotocol/sdk` (JavaScript, no build step)
- Node's built-in test runner (`node --test`) — no test framework dependency

## Setup

```bash
npm install
cp .env.example .env
# generate each token with:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Fill in `AUTH_TOKEN`, `ADMIN_AUTH_TOKEN`, `WEBHOOK_SECRET` in `.env` (must all
be different values). The database schema is created automatically on first
run — no separate migration command.

## Local development

```bash
npm run dev     # loads .env via --env-file, listens on :8796 by default
npm test         # node --test — unit + real HTTP protocol tests, no network
```

Seed a product directly for manual testing:

```bash
node -e "
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const db = new Database('./data/shop.db');
const now = new Date().toISOString();
db.prepare(\`INSERT INTO products (id, sku, resource_uri, stock, price_cents, currency, active, title, description, category, created_at, updated_at)
  VALUES (?, 'SKU-001', 'product://SKU-001', 10, 1999, 'USD', 1, 'Test Product', 'A thing you can buy', 'test', ?, ?)\`)
  .run(randomUUID(), now, now);
"
```

## Stress testing

```bash
MCP_URL=http://127.0.0.1:8796/mcp MCP_TOKEN=<your AUTH_TOKEN> \
  node scripts/stress-test.mjs [sku] [stock] [concurrent-buyers]
```

Runs concurrent `search_products` load plus a correctness check: N
simultaneous buyers against a SKU with a known stock level, asserting the
number of successfully placed orders exactly equals the stock (no
overselling under real concurrency).

## Production deploy (PM2 + nginx)

Generate the three secrets as files with restrictive permissions instead of
plain env vars, so they never appear in `pm2 env`/`ps` output:

```bash
mkdir -p secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > secrets/auth_token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > secrets/admin_auth_token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > secrets/webhook_secret
chmod 600 secrets/*
```

`ecosystem.config.cjs` is already wired to read `*_FILE` paths pointing at
`secrets/`; edit `PUBLIC_HOST` to your real domain, then:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

> **Note on restarting after an env var change**: `pm2 restart <name>` does
> **not** re-read `ecosystem.config.cjs` from disk — it only refreshes env
> vars already cached in PM2's memory from the original `pm2 start`. After
> adding/changing an env var (a new secret, a changed `PUBLIC_HOST`), use
> `pm2 delete <name> && pm2 start ecosystem.config.cjs` instead.

Minimal nginx reverse proxy (adjust `server_name`/cert paths/upstream port):

```nginx
server {
    listen 80;
    server_name shop-mcp.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name shop-mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8796;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;         # needed for the MCP SSE stream
        proxy_read_timeout 3600s;    # long-lived MCP sessions
        client_max_body_size 2m;
    }
}
```

`/mock-checkout/*` and `/webhooks/payment` need no separate nginx location —
they're plain routes on the same Express app behind `location /`.

## MCP endpoints

| Endpoint | Role | Auth |
|---|---|---|
| `POST/GET/DELETE /mcp` | sales agent | `Authorization: Bearer $AUTH_TOKEN` |
| `POST/GET/DELETE /admin/mcp` | admin agent | `Authorization: Bearer $ADMIN_AUTH_TOKEN` |
| `GET/POST /mock-checkout/:token` | mock payment page (no MCP, no bearer token) | none — it's a page a customer opens |
| `POST /webhooks/payment` | mock payment provider callback | HMAC signature (`X-Signature` header, `WEBHOOK_SECRET`) |

Tool/resource reference is identical to
[`../mcp-shop/README.md`](../mcp-shop/README.md#sales-agent-tools-mcp) — same
tool names, same input/output shapes, on both platforms.

## Project layout

```
src/
  server.js               process entry point — reads secrets/env, wires everything
  app.js                   generic "mount an MCP endpoint on this Express app" helper
                            (used twice: once for /mcp, once for /admin/mcp,
                            each with its own token + tool set)
  capabilities.js          wires resources+tools into each McpServer
  db.js                    all better-sqlite3 queries — real transactions throughout
  payments.js               mock charge/refund + HMAC sign/verify
  checkoutRoutes.js         the mock checkout HTML page + webhook handler
  migrate.js                runs migrations/*.sql in order on startup
  resources/                product://, order:// resource templates
  tools/                    sales-agent tool implementations
  tools/admin/                admin-only tool implementations
migrations/                 SQLite schema, applied in order automatically
test/
  db.test.js                 unit tests against an in-memory SQLite db
  http.test.js                full MCP protocol + real HTTP checkout/webhook tests
scripts/
  stress-test.mjs             concurrency/correctness load test against a live server
```
