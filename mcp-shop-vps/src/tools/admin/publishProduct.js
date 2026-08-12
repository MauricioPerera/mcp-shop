import { z } from "zod";
import { setPublished } from "../../db.js";

export function registerPublishProduct(server, db) {
  server.registerTool(
    "publish_product",
    {
      description: "Publica un producto (queda visible en search_products para el agente de ventas).",
      inputSchema: { sku: z.string().min(1) },
    },
    async ({ sku }) => {
      const result = setPublished(db, sku, true);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ sku, error: result.reason }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ sku, published: true }, null, 2) }] };
    }
  );
}

export function registerUnpublishProduct(server, db) {
  server.registerTool(
    "unpublish_product",
    {
      description: "Despublica un producto (deja de aparecer en search_products, sin borrarlo).",
      inputSchema: { sku: z.string().min(1) },
    },
    async ({ sku }) => {
      const result = setPublished(db, sku, false);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ sku, error: result.reason }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ sku, published: false }, null, 2) }] };
    }
  );
}
