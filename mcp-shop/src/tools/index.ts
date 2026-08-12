import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchProducts } from "./searchProducts";
import { registerCreateOrder } from "./createOrder";
import { registerCancelOrder } from "./cancelOrder";
import { registerListOrders } from "./listOrders";

export function registerTools(server: McpServer, env: Env, publicUrl: string) {
  registerSearchProducts(server, env);
  registerCreateOrder(server, env, publicUrl);
  registerCancelOrder(server, env);
  registerListOrders(server, env, publicUrl);
}
