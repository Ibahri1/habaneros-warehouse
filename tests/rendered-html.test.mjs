import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("warehouse app contains the required browser workflows", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["Submit Warehouse Order","Order queue","Receive inventory","Adjust inventory","Movement Log","Users & Codes","Out for Delivery","Delivered","Cancelled"]) assert.ok(app.includes(text), text);
  assert.ok(!/checkout|payment screen|admin@example/i.test(app));
});

test("migration protects inventory and PINs", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260811000100_initial_warehouse_schema.sql", import.meta.url), "utf8");
  for (const text of ["pin_hash","crypt(input_pin,pin_hash)","enable row level security","submit_warehouse_order","set_order_status","inventory_movements","available integer generated always"]) assert.ok(sql.includes(text), text);
  assert.ok(!sql.includes("service_role"));
});

test("frontend environment contains only public placeholders", async () => {
  const env = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(env,/NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(env,/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(env,/SERVICE_ROLE|SECRET_KEY/);
});
