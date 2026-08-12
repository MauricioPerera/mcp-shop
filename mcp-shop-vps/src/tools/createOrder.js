import { z } from "zod";
import { createOrder } from "../db.js";

export function registerCreateOrder(server, db, publicUrl) {
  server.registerTool(
    "create_order",
    {
      description:
        "Crea un pedido y reserva el stock, y devuelve un link de pago (MOCK, no hay credenciales reales). " +
        "El pedido queda en estado 'pending' hasta que el cliente paga en ese link: la confirmacion llega " +
        "despues, de forma asincrona, via webhook — no hay forma de saber el resultado en el momento de esta " +
        "llamada. Usa list_orders o el resource order://{id} mas tarde para ver si quedo 'confirmed' o 'cancelled'.",
      inputSchema: {
        items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
        customer_ref: z.string().optional(),
      },
    },
    async ({ items, customer_ref }) => {
      const result = createOrder(db, items, customer_ref);
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "rejected", rejected_reason: result.reason, sku: result.sku }, null, 2),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                order_id: result.order.orderId,
                status: result.order.status,
                total: { amount: result.order.totalCents / 100, currency: result.order.currency },
                items: result.order.items.map((it) => ({
                  sku: it.sku,
                  title: it.title,
                  quantity: it.quantity,
                  unit_price: { amount: it.unit_price_cents / 100, currency: result.order.currency },
                })),
                payment: {
                  status: result.order.payment.status,
                  checkout_url: `${publicUrl}/mock-checkout/${result.order.payment.checkoutToken}`,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
