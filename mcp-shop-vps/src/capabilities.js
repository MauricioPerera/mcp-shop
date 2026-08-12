import { registerProductResources } from "./resources/product.js";
import { registerOrderResources } from "./resources/order.js";
import { registerTools } from "./tools/index.js";
import { registerAdminTools } from "./tools/admin/index.js";

export function registerCustomerCapabilities(server, db, publicUrl) {
  registerProductResources(server, db);
  registerOrderResources(server, db, publicUrl);
  registerTools(server, db, publicUrl);
}

export function registerAdminCapabilities(server, db, publicUrl) {
  registerProductResources(server, db);
  registerOrderResources(server, db, publicUrl);
  registerAdminTools(server, db);
}
