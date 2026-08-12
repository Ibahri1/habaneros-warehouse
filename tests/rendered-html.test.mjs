import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("warehouse app contains the required browser workflows", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["Submit Warehouse Order","Order queue","Order history","Adjust inventory","Movement Log","Employees & Codes","Out for Delivery","Delivered","Cancelled","print-notes","deleteWarehouseProduct","deleteWarehouseLocation","deleteWarehouseUser","ProductImageUpload","Item Location"]) assert.ok(app.includes(text), text);
  assert.ok(!app.includes('[["receiving","Receive"]'), "Receive navigation is removed");
  assert.ok(!app.includes("Archive product"), "Archive product control is removed");
  for (const text of ["Delete from queue","Delete selected delivered orders from queue","queue_hidden","BrandLogo","warehouse-theme"]) assert.ok(app.includes(text), text);
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
  assert.ok(adapter.includes("warehouse_hide_delivered_orders"));
  assert.ok(app.includes('...(role==="admin"?[["users","Employees & Codes"]'), "administrator navigation is flattened into the sidebar");
  assert.ok(!app.includes('...[role==="admin"?[["users"'), "administrator navigation is not nested");
});

test("product image saves expose progress, validation, and rollback failures", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["Uploading & saving…","Image must be 6 MB or smaller.","Use a JPG, PNG, WebP, or GIF image.","aria-busy={saving}","if(uploadedImage)await removeWarehouseProductImage(uploadedImage)"]) assert.ok(app.includes(text), text);
  assert.ok(app.indexOf("await uploadWarehouseProductImage") > app.indexOf("await p.act(async()=>"), "image upload runs inside the visible save operation");
  assert.ok(app.indexOf("setEditor(null)") > app.indexOf("throw error"), "the editor closes only after successful save");
});

test("delivered queue removal preserves history and enforces staff roles", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260812065358_queue_hidden_delivered_orders.sql", import.meta.url), "utf8");
  for (const text of ["hidden_from_queue_at","status='Delivered'","warehouse_hide_delivered_orders","warehouse_get_queue_hidden_orders","('fulfillment','admin')","grant execute"]) assert.ok(sql.includes(text), text);
  assert.doesNotMatch(sql,/delete\s+from\s+public\.orders/i);
});

test("frontend environment contains only public placeholders", async () => {
  const env = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(env,/VITE_SUPABASE_URL/);
  assert.match(env,/VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(env,/SERVICE_ROLE|SECRET_KEY/);
});

test("mobile navigation stays fixed, scrollable, and clear of page content", async () => {
  const css = await readFile(new URL("../app/mobile-overrides.css", import.meta.url), "utf8");
  for (const text of ["@media (max-width: 768px)","position: fixed","overflow-x: auto","aside nav button:nth-child(n+5)","env(safe-area-inset-bottom)","padding-bottom: calc(var(--mobile-nav-height)"]) assert.ok(css.includes(text), text);
});
