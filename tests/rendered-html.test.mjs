import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("warehouse app contains the required browser workflows", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["Submit Warehouse Order","Order queue","Order history","Adjust inventory","Movement Log","Employees & Codes","Out for Delivery","Delivered","Cancelled","print-notes","deleteWarehouseProduct","deleteWarehouseLocation","deleteWarehouseUser","ProductImageUpload","Item Location"]) assert.ok(app.includes(text), text);
  assert.ok(!app.includes('[["receiving","Receive"]'), "Receive navigation is removed");
  assert.ok(!app.includes("Archive product"), "Archive product control is removed");
  assert.ok(!/checkout|payment screen|admin@example/i.test(app));
});

test("migration protects inventory and PINs", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260811000100_initial_warehouse_schema.sql", import.meta.url), "utf8");
  for (const text of ["access_code_hash","crypt(input_pin, access_code_hash)","enable row level security","warehouse_submit_order","warehouse_update_order","app_user_sessions","inventory_movements","available integer generated always"]) assert.ok(sql.includes(text), text);
  assert.ok(!sql.includes("service_role"));
});

test("admin actions call the live warehouse adapter", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../lib/supabase.ts", import.meta.url), "utf8");
  for (const text of ["saveWarehouseProduct","saveWarehouseCategory","saveWarehouseLocation","saveWarehouseUser","changeWarehouseInventory","window.print()","setSelectedOrder(null)"]) assert.ok(app.includes(text), text);
  for (const text of ["signInAnonymously","warehouse_get_app_data","warehouse_save_user","warehouse_change_inventory"]) assert.ok(adapter.includes(text), text);
  assert.ok(app.includes('...(role==="admin"?[["users","Employees & Codes"]'), "administrator navigation is flattened into the sidebar");
  assert.ok(!app.includes('...[role==="admin"?[["users"'), "administrator navigation is not nested");
});

test("frontend environment contains only public placeholders", async () => {
  const env = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(env,/VITE_SUPABASE_URL/);
  assert.match(env,/VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(env,/SERVICE_ROLE|SECRET_KEY/);
});
