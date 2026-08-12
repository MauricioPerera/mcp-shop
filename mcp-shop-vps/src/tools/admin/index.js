import { registerCreateProduct } from "./createProduct.js";
import { registerUpdateProduct } from "./updateProduct.js";
import { registerSetStock } from "./setStock.js";
import { registerPublishProduct, registerUnpublishProduct } from "./publishProduct.js";
import { registerUpdateOrderStatus } from "./updateOrderStatus.js";

export function registerAdminTools(server, db) {
  registerCreateProduct(server, db);
  registerUpdateProduct(server, db);
  registerSetStock(server, db);
  registerPublishProduct(server, db);
  registerUnpublishProduct(server, db);
  registerUpdateOrderStatus(server, db);
}
