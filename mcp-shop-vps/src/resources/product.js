import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findProductBySku } from "../db.js";

function toOkfMarkdown(product) {
  const frontmatter = [
    "---",
    "type: Product",
    `title: ${product.title}`,
    `sku: ${product.sku}`,
    `category: ${product.category}`,
    `resource: "${product.resource_uri}"`,
    `price: { amount: ${(product.price_cents / 100).toFixed(2)}, currency: "${product.currency}" }`,
    `status: ${product.stock > 0 ? "stable" : "deprecated"}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n\n${product.description}\n`;
}

export function registerProductResources(server, db) {
  server.resource("product", new ResourceTemplate("product://{sku}", { list: undefined }), async (uri, { sku }) => {
    const product = findProductBySku(db, String(sku));
    if (!product) {
      return { contents: [{ uri: uri.href, text: `Product ${sku} not found`, mimeType: "text/plain" }] };
    }
    return { contents: [{ uri: uri.href, text: toOkfMarkdown(product), mimeType: "text/markdown" }] };
  });
}
