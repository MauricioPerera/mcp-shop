import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { registerCustomerCapabilities, registerAdminCapabilities } from "./capabilities";
import { isAuthorized, unauthorizedResponse } from "./auth";
import { handleMockCheckoutGet, handleMockCheckoutPost, handleWebhookRequest } from "./checkoutRoutes";

export class ShopMCP extends McpAgent<Env, {}, {}> {
  server = new McpServer({ name: "shop-mcp", version: "0.1.0" });

  async init() {
    registerCustomerCapabilities(this.server, this.env, this.env.PUBLIC_URL);
  }
}

export class ShopAdminMCP extends McpAgent<Env, {}, {}> {
  server = new McpServer({ name: "shop-mcp-admin", version: "0.1.0" });

  async init() {
    registerAdminCapabilities(this.server, this.env, this.env.PUBLIC_URL);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Plain HTTP routes — no MCP session, no bearer auth. A real customer
    // paying, and a real payment provider's webhook caller, are never MCP
    // clients holding our tool tokens; the webhook is authenticated by HMAC
    // signature instead (see payments.ts).
    const checkoutMatch = url.pathname.match(/^\/mock-checkout\/(.+)$/);
    if (checkoutMatch) {
      const token = checkoutMatch[1];
      if (request.method === "GET") return handleMockCheckoutGet(env, token);
      if (request.method === "POST") return handleMockCheckoutPost(request, env, token);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/webhooks/payment" && request.method === "POST") {
      return handleWebhookRequest(request, env);
    }

    if (url.pathname.startsWith("/admin")) {
      if (!(await isAuthorized(request, env.ADMIN_AUTH_TOKEN))) {
        return unauthorizedResponse();
      }
      return ShopAdminMCP.serve("/admin/mcp", { binding: "MCP_SHOP_ADMIN" }).fetch(request, env, ctx);
    }

    if (!(await isAuthorized(request, env.AUTH_TOKEN))) {
      return unauthorizedResponse();
    }
    return ShopMCP.serve("/mcp", { binding: "MCP_SHOP" }).fetch(request, env, ctx);
  },
};
