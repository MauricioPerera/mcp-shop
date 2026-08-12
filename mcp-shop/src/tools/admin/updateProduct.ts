import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateProduct } from "../../db";

export function registerUpdateProduct(server: McpServer, env: Env) {
  server.registerTool(
    "update_product",
    {
      description:
        "Edita campos de un producto existente (titulo, descripcion, categoria, precio). Solo actualiza los campos provistos.",
      inputSchema: {
        sku: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        price_cents: z.number().int().positive().optional(),
      },
    },
    async ({ sku, title, description, category, price_cents }) => {
      const result = await updateProduct(env.DB, sku, { title, description, category, priceCents: price_cents });
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ sku, error: result.reason }, null, 2) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sku: result.product.sku,
                title: result.product.title,
                description: result.product.description,
                category: result.product.category,
                price: { amount: result.product.price_cents / 100, currency: result.product.currency },
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
