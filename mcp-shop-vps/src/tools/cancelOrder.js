import { z } from "zod";
import { cancelOrder } from "../db.js";

export function registerCancelOrder(server, db) {
  server.registerTool(
    "cancel_order",
    {
      description: "Cancela un pedido y repone stock. Idempotente ante pedidos ya cancelados o cumplidos.",
      inputSchema: { order_id: z.string() },
    },
    async ({ order_id }) => {
      const result = cancelOrder(db, order_id);
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
