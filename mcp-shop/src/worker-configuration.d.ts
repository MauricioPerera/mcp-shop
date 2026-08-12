interface Env {
  DB: D1Database;
  MCP_SHOP: DurableObjectNamespace;
  MCP_SHOP_ADMIN: DurableObjectNamespace;
  AUTH_TOKEN: string;
  ADMIN_AUTH_TOKEN: string;
  WEBHOOK_SECRET: string;
  PUBLIC_URL: string;
}

declare namespace Cloudflare {
  type Env = globalThis.Env;
}
