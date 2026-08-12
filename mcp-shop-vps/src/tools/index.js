import { registerSearchProducts } from "./searchProducts.js";
import { registerCreateOrder } from "./createOrder.js";
import { registerCancelOrder } from "./cancelOrder.js";
import { registerListOrders } from "./listOrders.js";

export function registerTools(server, db, publicUrl) {
  registerSearchProducts(server, db);
  registerCreateOrder(server, db, publicUrl);
  registerCancelOrder(server, db);
  registerListOrders(server, db, publicUrl);
}
