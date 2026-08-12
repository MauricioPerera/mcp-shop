import { readFileSync } from "node:fs";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { openDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { createApp } from "./app.js";
import { registerCustomerCapabilities, registerAdminCapabilities } from "./capabilities.js";
import { registerCheckoutRoutes } from "./checkoutRoutes.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8796;
const DB_PATH = process.env.DB_PATH ?? "./data/shop.db";
const PUBLIC_HOST = process.env.PUBLIC_HOST;

function readSecret(envVar, fileEnvVar) {
  const filePath = process.env[fileEnvVar];
  if (filePath) return readFileSync(filePath, "utf8").trim();
  return process.env[envVar];
}

// Prefer a restricted-permission secret file (production) over a plain env
// var (convenient for local dev), so tokens don't sit in `ps`/pm2 env dumps.
const AUTH_TOKEN = readSecret("AUTH_TOKEN", "AUTH_TOKEN_FILE");
const ADMIN_AUTH_TOKEN = readSecret("ADMIN_AUTH_TOKEN", "ADMIN_AUTH_TOKEN_FILE");
const WEBHOOK_SECRET = readSecret("WEBHOOK_SECRET", "WEBHOOK_SECRET_FILE");

if (!AUTH_TOKEN) {
  console.error("AUTH_TOKEN or AUTH_TOKEN_FILE env var is required");
  process.exit(1);
}
if (!ADMIN_AUTH_TOKEN) {
  console.error("ADMIN_AUTH_TOKEN or ADMIN_AUTH_TOKEN_FILE env var is required");
  process.exit(1);
}
if (ADMIN_AUTH_TOKEN === AUTH_TOKEN) {
  console.error("ADMIN_AUTH_TOKEN must be different from AUTH_TOKEN");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error("WEBHOOK_SECRET or WEBHOOK_SECRET_FILE env var is required");
  process.exit(1);
}

const db = openDb(DB_PATH);
runMigrations(db);

// PUBLIC_URL is what gets embedded in checkout_url — must be reachable by a
// real customer's browser. INTERNAL_URL is loopback-only, used for the mock
// checkout page's self-call to the webhook (same process, no reason to
// round-trip through the public domain/Cloudflare for that hop).
const PUBLIC_URL = PUBLIC_HOST ? `https://${PUBLIC_HOST}` : `http://127.0.0.1:${PORT}`;
const INTERNAL_URL = `http://127.0.0.1:${PORT}`;

const allowedHosts = ["127.0.0.1", "localhost"];
if (PUBLIC_HOST) allowedHosts.push(PUBLIC_HOST);
const app = createMcpExpressApp({ host: "127.0.0.1", allowedHosts });

const { transports: customerTransports } = createApp({
  app,
  db,
  authToken: AUTH_TOKEN,
  serverName: "shop-mcp-vps",
  registerCapabilities: registerCustomerCapabilities,
  mountPath: "/mcp",
  publicUrl: PUBLIC_URL,
});

const { transports: adminTransports } = createApp({
  app,
  db,
  authToken: ADMIN_AUTH_TOKEN,
  serverName: "shop-mcp-vps-admin",
  registerCapabilities: registerAdminCapabilities,
  mountPath: "/admin/mcp",
  publicUrl: PUBLIC_URL,
});

registerCheckoutRoutes(app, db, {
  webhookSecret: WEBHOOK_SECRET,
  webhookUrl: `${INTERNAL_URL}/webhooks/payment`,
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `shop-mcp listening on 127.0.0.1:${PORT} (/mcp + /admin/mcp + /mock-checkout + /webhooks/payment), db=${DB_PATH}`
  );
});

process.on("SIGINT", async () => {
  for (const transports of [customerTransports, adminTransports]) {
    for (const sessionId of Object.keys(transports)) {
      try {
        await transports[sessionId].close();
      } catch {
        // best-effort cleanup on shutdown
      }
    }
  }
  process.exit(0);
});
