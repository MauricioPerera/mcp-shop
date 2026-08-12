import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCreateProduct } from "./createProduct";
import { registerUpdateProduct } from "./updateProduct";
import { registerSetStock } from "./setStock";
import { registerPublishProduct, registerUnpublishProduct } from "./publishProduct";
import { registerUpdateOrderStatus } from "./updateOrderStatus";

export function registerAdminTools(server: McpServer, env: Env) {
  registerCreateProduct(server, env);
  registerUpdateProduct(server, env);
  registerSetStock(server, env);
  registerPublishProduct(server, env);
  registerUnpublishProduct(server, env);
  registerUpdateOrderStatus(server, env);
}
