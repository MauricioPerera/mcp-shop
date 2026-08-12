import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelOrderTx } from "../db";

export function registerCancelOrder(server: McpServer, env: Env) {
  server.registerTool(
    "cancel_order",
    {
      description: "Cancela un pedido y repone stock. Idempotente ante pedidos ya cancelados o cumplidos.",
      inputSchema: { order_id: z.string() },
    },
    async ({ order_id }) => {
      const result = await cancelOrderTx(env.DB, order_id);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ order_id, error: result.reason }, null, 2) }],
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ order_id, status: result.order.status, error: null }, null, 2) },
        ],
      };
    }
  );
}
