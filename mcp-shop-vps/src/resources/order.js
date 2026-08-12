import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOrder } from "../db.js";

export function registerOrderResources(server, db, publicUrl) {
  server.resource("order", new ResourceTemplate("order://{id}", { list: undefined }), async (uri, { id }) => {
    const result = getOrder(db, String(id));
    if (!result) {
      return { contents: [{ uri: uri.href, text: `Order ${id} not found`, mimeType: "text/plain" }] };
    }
    const payment =
      result.payment && result.payment.status === "pending"
        ? { ...result.payment, checkout_url: `${publicUrl}/mock-checkout/${result.payment.checkoutToken}` }
        : result.payment;
    return {
      contents: [
        { uri: uri.href, text: JSON.stringify({ ...result, payment }, null, 2), mimeType: "application/json" },
      ],
    };
  });
}
