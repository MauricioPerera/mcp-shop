import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import initSql from "../migrations/0001_init.sql?raw";
import productDetailsSql from "../migrations/0002_product_details.sql?raw";
import paymentsSql from "../migrations/0003_payments.sql?raw";
import paymentsLinkFlowSql from "../migrations/0004_payments_link_flow.sql?raw";

function toQueries(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`);
}

const migrations: D1Migration[] = [
  { name: "0001_init.sql", queries: toQueries(initSql) },
  { name: "0002_product_details.sql", queries: toQueries(productDetailsSql) },
  { name: "0003_payments.sql", queries: toQueries(paymentsSql) },
  { name: "0004_payments_link_flow.sql", queries: toQueries(paymentsLinkFlowSql) },
];

export default migrations;
