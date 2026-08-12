import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProductResources } from "./resources/product";
import { registerOrderResources } from "./resources/order";
import { registerTools } from "./tools";
import { registerAdminTools } from "./tools/admin";

export function registerCustomerCapabilities(server: McpServer, env: Env, publicUrl: string) {
  registerProductResources(server, env);
  registerOrderResources(server, env, publicUrl);
  registerTools(server, env, publicUrl);
}

export function registerAdminCapabilities(server: McpServer, env: Env, publicUrl: string) {
  registerProductResources(server, env);
  registerOrderResources(server, env, publicUrl);
  registerAdminTools(server, env);
}
