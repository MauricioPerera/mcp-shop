import { z } from "zod";
import { searchProducts } from "../db.js";

export function registerSearchProducts(server, db) {
  server.registerTool(
    "search_products",
    {
      description:
        "Busca productos activos por texto libre (titulo/descripcion/sku), categoria y disponibilidad de stock. " +
        "Si 'query' no matchea nada, devuelve el catalogo completo (respetando category/in_stock) con query_matched=false " +
        "en vez de una lista vacia.",
      inputSchema: {
        query: z.string().optional(),
        category: z.string().optional(),
        in_stock: z.boolean().optional(),
        limit: z.number().min(1).max(50).default(20),
        offset: z.number().min(0).default(0),
      },
    },
    async ({ query, category, in_stock, limit, offset }) => {
      let rows = searchProducts(db, { query, category, inStock: in_stock, limit, offset });
      let queryMatched = true;

      if (query && rows.length === 0) {
        rows = searchProducts(db, { category, inStock: in_stock, limit, offset });
        queryMatched = false;
      }

      const items = rows.map((p) => ({
        sku: p.sku,
        title: p.title,
        description: p.description,
        category: p.category,
        price: { amount: p.price_cents / 100, currency: p.currency },
        in_stock: p.stock > 0,
        resource_uri: p.resource_uri,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ items, query_matched: queryMatched }, null, 2) }] };
    }
  );
}
