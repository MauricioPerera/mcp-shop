import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listOrders } from "../db";

export function registerListOrders(server: McpServer, env: Env, publicUrl: string) {
  server.registerTool(
    "list_orders",
    {
      description: "Lista pedidos, opcionalmente filtrados por cliente o estado.",
      inputSchema: {
        customer_ref: z.string().optional(),
        status: z.enum(["pending", "confirmed", "cancelled", "fulfilled"]).optional(),
        limit: z.number().min(1).max(50).default(20),
        offset: z.number().min(0).default(0),
      },
    },
    async ({ customer_ref, status, limit, offset }) => {
      const rows = await listOrders(env.DB, { customerRef: customer_ref, status, limit, offset });
      const orders = rows.map((o) => ({
        order_id: o.id,
        status: o.status,
        total: { amount: o.total_cents / 100, currency: o.currency },
        items: o.items.map((it) => ({
          sku: it.sku,
          title: it.title,
          quantity: it.quantity,
          unit_price: { amount: it.unit_price_cents / 100, currency: o.currency },
        })),
        payment: o.payment
          ? {
              status: o.payment.status,
              transaction_id: o.payment.transaction_id,
              card_last4: o.payment.card_last4,
              checkout_url:
                o.payment.status === "pending" && o.payment.checkout_token
                  ? `${publicUrl}/mock-checkout/${o.payment.checkout_token}`
                  : undefined,
            }
          : null,
        resource_uri: `order://${o.id}`,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ items: orders }, null, 2) }] };
    }
  );
}
