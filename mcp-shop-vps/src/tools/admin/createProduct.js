import { z } from "zod";
import { createProduct } from "../../db.js";

export function registerCreateProduct(server, db) {
  server.registerTool(
    "create_product",
    {
      description: "Da de alta un producto nuevo en el catalogo. Falla si el SKU ya existe.",
      inputSchema: {
        sku: z.string().min(1),
        title: z.string().min(1),
        description: z.string().default(""),
        category: z.string().default(""),
        price_cents: z.number().int().positive(),
        stock: z.number().int().min(0).default(0),
        published: z.boolean().default(true),
      },
    },
    async ({ sku, title, description, category, price_cents, stock, published }) => {
      const result = createProduct(db, {
        sku,
        title,
        description,
        category,
        priceCents: price_cents,
        stock,
        active: published,
      });
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
                price: { amount: result.product.price_cents / 100, currency: result.product.currency },
                stock: result.product.stock,
                published: !!result.product.active,
                resource_uri: result.product.resource_uri,
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
