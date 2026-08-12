import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setStock } from "../../db";

export function registerSetStock(server: McpServer, env: Env) {
  server.registerTool(
    "set_stock",
    {
      description: "Fija el stock de un producto a un valor absoluto (reposicion o correccion manual).",
      inputSchema: {
        sku: z.string().min(1),
        stock: z.number().int().min(0),
      },
    },
    async ({ sku, stock }) => {
      const result = await setStock(env.DB, sku, stock);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ sku, error: result.reason }, null, 2) }] };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ sku: result.product.sku, stock: result.product.stock }, null, 2) },
        ],
      };
    }
  );
}
