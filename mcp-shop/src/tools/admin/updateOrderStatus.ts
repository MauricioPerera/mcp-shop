import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateOrderStatus } from "../../db";

export function registerUpdateOrderStatus(server: McpServer, env: Env) {
  server.registerTool(
    "update_order_status",
    {
      description:
        "Cambia el estado de un pedido. Transiciones validas: confirmed->fulfilled (marca entregado, no toca stock) " +
        "y confirmed->cancelled (repone stock, mismo efecto que cancel_order). Cualquier otra transicion se rechaza.",
      inputSchema: {
        order_id: z.string().min(1),
        status: z.enum(["fulfilled", "cancelled"]),
      },
    },
    async ({ order_id, status }) => {
      const result = await updateOrderStatus(env.DB, order_id, status);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ order_id, error: result.reason }, null, 2) }] };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ order_id, status: result.order.status, error: null }, null, 2) },
        ],
      };
    }
  );
}
