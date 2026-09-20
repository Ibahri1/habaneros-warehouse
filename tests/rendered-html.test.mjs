import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { consolidatePickingItems } from "../lib/picking-list.mjs";

test("warehouse app contains the required browser workflows", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["Submit Warehouse Order","Order queue","Order history","Adjust inventory","Movement Log","Employees & Codes","Out for Delivery","Delivered","Cancelled","print-notes","deleteWarehouseProduct","deleteWarehouseLocation","deleteWarehouseUser","ProductImageUpload","Item Location"]) assert.ok(app.includes(text), text);
  assert.ok(!app.includes('[["receiving","Receive"]'), "Receive navigation is removed");
  assert.ok(!app.includes("Archive product"), "Archive product control is removed");
  for (const text of ["queue_hidden","BrandLogo"]) assert.ok(app.includes(text), text);
  for (const text of ["warehouse-theme","toggleTheme","theme-toggle","data-theme"]) assert.ok(!app.includes(text), `${text} is removed`);
  assert.ok(!/checkout|payment screen|admin@example/i.test(app));
});

test("migration protects inventory and PINs", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260811000100_initial_warehouse_schema.sql", import.meta.url), "utf8");
  for (const text of ["access_code_hash","crypt(input_pin, access_code_hash)","enable row level security","warehouse_submit_order","warehouse_update_order","app_user_sessions","inventory_movements","available integer generated always"]) assert.ok(sql.includes(text), text);
  assert.ok(!sql.includes("service_role"));
});

test("fulfillment delivery is checked and generic status changes are admin-only", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260920004913_fulfillment_picking_completion.sql", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../lib/supabase.ts", import.meta.url), "utf8");
  for (const text of ["picked_at timestamptz","warehouse_set_order_item_picked","input_expected_picked_at","for update","warehouse_complete_picked_order","unchecked_count>0","warehouse_update_order_admin_impl","Administrator access required","already_delivered"]) assert.ok(sql.includes(text), text);
  assert.ok(sql.includes("revoke all on function public.warehouse_update_order_admin_impl"));
  assert.ok(sql.includes("is distinct from 'admin'::public.app_role"));
  assert.ok(app.includes('userRole==="admin"&&<><label>Update status</label>'));
  assert.ok(app.includes("All items fulfilled"));
  assert.ok(app.includes("No, keep picking"));
  assert.ok(app.includes("Yes, mark delivered"));
  assert.ok(adapter.includes('"warehouse_get_picking_progress"'));
  assert.ok(adapter.includes('"warehouse_complete_picked_order"'));
});

test("admin actions call the live warehouse adapter", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../lib/supabase.ts", import.meta.url), "utf8");
  for (const text of ["saveWarehouseProduct","saveWarehouseCategory","saveWarehouseLocation","saveWarehouseUser","adjustWarehouseInventory","window.print()","setSelectedOrder(null)"]) assert.ok(app.includes(text), text);
  for (const text of ["signInAnonymously","warehouse_get_app_data","warehouse_save_user","warehouse_bulk_adjust_inventory"]) assert.ok(adapter.includes(text), text);
  assert.ok(adapter.includes("warehouse_hide_delivered_orders"));
  assert.ok(app.includes('const adminNav:[View,string][]='), "administrator navigation remains available");
  assert.ok(app.includes('["users","Employees & Codes"]'), "administrator employee tools remain available");
});

test("product image saves expose progress, validation, and rollback failures", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["Uploading & saving…","Image must be 6 MB or smaller.","Use a JPG, PNG, WebP, or GIF image.","aria-busy={saving}","if(uploadedImage)await removeWarehouseProductImage(uploadedImage)"]) assert.ok(app.includes(text), text);
  assert.ok(app.indexOf("await uploadWarehouseProductImage") > app.indexOf("await p.act(async()=>"), "image upload runs inside the visible save operation");
  assert.ok(app.indexOf("setEditor(null)") > app.indexOf("throw error"), "the editor closes only after successful save");
});

test("product images are cropped to the card ratio before Storage upload", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const text of ["Resize &amp; Crop","Product Preview","Zoom out","Zoom in","Rotate left","Rotate right","Apply crop","output.width=1200","output.height=720","image/webp","drawProductCrop"]) assert.ok(app.includes(text), text);
  for (const text of ["grid-template-rows:160px","object-fit:cover","overflow:hidden",".crop-stage","aspect-ratio:5/3"]) assert.ok(css.includes(text), text);
});

test("delivered queue removal preserves history and enforces staff roles", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260812065358_queue_hidden_delivered_orders.sql", import.meta.url), "utf8");
  for (const text of ["hidden_from_queue_at","status='Delivered'","warehouse_hide_delivered_orders","warehouse_get_queue_hidden_orders","('fulfillment','admin')","grant execute"]) assert.ok(sql.includes(text), text);
  assert.doesNotMatch(sql,/delete\s+from\s+public\.orders/i);
});

test("finalized orders move to history immediately and can be transactionally reopened", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260812074819_reopen_finalized_orders_and_queue_removal.sql", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["status in ('Delivered','Cancelled')","Delivery reversed after status correction","Cancellation reversed after status correction","available>=item.requested_quantity","hidden_from_queue_at=case when input_status<>old_status then null","private.current_app_role() not in ('fulfillment','admin')","for update"]) assert.ok(sql.includes(text), text);
  assert.doesNotMatch(sql,/delete\s+from\s+public\.orders/i);
  for (const text of ["Inventory and reservations will be updated automatically.",'const activeOrderStatuses=new Set(["Submitted","Confirmed","Picking","Out for Delivery"])','p.data.orders.filter((o:Order)=>activeOrderStatuses.has(o.status))','p.data.orders.filter((o:Order)=>isFinalizedOrder(o.status))','setSelectedOrder(null);setView("orders")']) assert.ok(app.includes(text), text);
  for (const text of ["historyCutoff","Delivered orders remain here for 30 days","Remove selected Delivered/Cancelled orders from queue"]) assert.ok(!app.includes(text), `${text} is obsolete`);
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

test("managers support multiple locations and all-location access", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260813003347_multi_location_managers_bulk_inventory.sql", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  for (const text of ["all_locations boolean not null default false","'location_ids'","input_location_ids uuid[]","Managers require at least one location","l.is_active","private.current_app_role()<>'admin'"]) assert.ok(sql.includes(text), text);
  for (const text of ["All locations","Select all that apply","New active locations will be included automatically.","location_ids"]) assert.ok(app.includes(text), text);
});

test("single-product inventory adjustment is transactional and fully logged", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260919011330_single_product_inventory_adjustment.sql", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../lib/supabase.ts", import.meta.url), "utf8");
  for (const text of ["warehouse_adjust_inventory","for update","Quantity change cannot be zero","Adjustment would reduce stock below reserved inventory","insert into public.inventory_movements","private.current_app_role() not in ('fulfillment','admin')","inventory.on_hand-inventory.reserved"]) assert.ok(sql.includes(text), text);
  for (const text of ["Inventory adjustment","Available inventory","How many units should be added?","Original","After change","Pending net adjustment","Save adjustment","Discard / Cancel"]) assert.ok(app.includes(text), text);
  for (const text of ["Apply adjustment to","product-checklist","bulk-adjustment",'className="product-check"']) assert.ok(!app.includes(text), `${text} bulk UI is removed`);
  assert.ok(adapter.includes('rpc<{on_hand:number;reserved:number;available:number}>("warehouse_adjust_inventory"'));
});

test("management searches, product category filter, and requested-left picking layout are present", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for(const text of ["Search products, SKU, or unit","Search categories","Search locations","All categories","Uncategorized","clear-search","pick-requested"])assert.ok(app.includes(text),text);
  assert.ok(!app.includes('<span className="pick-num">{i+1}</span>'));
  for(const text of [".inventory-product-row",".inventory-stepper",".inventory-comparison",".pick-requested"])assert.ok(css.includes(text),text);
});

test("fulfillment navigation is restricted while admin and manager navigation remain intact", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  assert.ok(app.includes('const fulfillmentNav:[View,string][]=[["orders","Orders"]]'));
  assert.ok(app.includes('const fulfillmentViews:View[]=["orders"]'));
  assert.ok(app.includes('role==="fulfillment"&&!fulfillmentViews.includes(view)?"orders":view'));
  for(const text of ['["dashboard","Dashboard"]','["users","Employees & Codes"]','["catalog","Catalog"]','["history","My Orders"]'])assert.ok(app.includes(text),text);
});

test("order picking supports persistent item checkoff without changing status", async () => {
  const app = await readFile(new URL("../app/warehouse-app.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for(const text of ["warehouse-picked-items:","togglePicked","is-picked",'type="checkbox"'])assert.ok(app.includes(text),text);
  assert.ok(css.includes(".pick-row.is-picked"));
  assert.ok(!css.includes('[data-theme="dark"]'));
});

test("picking list consolidates overlapping products and retains order references", () => {
  const products=[{id:"shirt",category:"Uniforms",item_location:"A1"},{id:"cup",category:"Supplies",item_location:"B2"}];
  const orders=[
    {order_number:"0001",items:[{product_id:"shirt",name:"Shirt",sku:"SH-1",unit_size:"Each",item_location:"A1",requested_quantity:1}]},
    {order_number:"0002",items:[{product_id:"shirt",name:"Shirt",sku:"SH-1",unit_size:"Each",item_location:"A1",requested_quantity:2},{product_id:"cup",name:"Cup",sku:"CP-1",unit_size:"Case",item_location:"B2",requested_quantity:1}]},
  ];
  const result=consolidatePickingItems(orders,products);
  assert.equal(result.length,2);
  assert.equal(result.find(item=>item.name==="Shirt").quantity,3);
  assert.deepEqual(result.find(item=>item.name==="Shirt").orders,["0001","0002"]);
  assert.equal(result.find(item=>item.name==="Cup").quantity,1);
});

test("administrator reorder reports are secure, idempotent, and preview before email", async () => {
  const app=await readFile(new URL("../app/warehouse-app.tsx",import.meta.url),"utf8");
  const sql=await readFile(new URL("../supabase/migrations/20260919044053_reorder_reports.sql",import.meta.url),"utf8");
  const edge=await readFile(new URL("../supabase/functions/reorder-reports/index.ts",import.meta.url),"utf8");
  for(const text of ['["reorderReports","Reorder Reports"]','Generate & Email Now','Confirm & Send','Test Gmail connection','Previewing never sends email'])assert.ok(app.includes(text),text);
  for(const text of ["private.current_app_role()<>'admin'","p.low_stock_threshold is not null","coalesce(wi.available,0)<=p.low_stock_threshold","scheduled_run_key text unique","America/Los_Angeles","on conflict(scheduled_run_key) do nothing","to service_role"])assert.ok(sql.includes(text),text);
  for(const text of ['action==="preview"','action==="confirm"','smtp.gmail.com','port:465','secure:true','WAREHOUSE_GMAIL_APP_PASSWORD','attachments:pdf?','status:"uncertain"'])assert.ok(edge.includes(text),text);
  assert.ok(!app.includes("WAREHOUSE_GMAIL_APP_PASSWORD"));
});

test("reorder report preflight allows actual supabase-js headers before authentication", async()=>{
  const edge=await readFile(new URL("../supabase/functions/reorder-reports/index.ts",import.meta.url),"utf8");
  const adapter=await readFile(new URL("../lib/supabase.ts",import.meta.url),"utf8");
  for(const header of ["authorization","x-client-info","apikey","content-type","x-reorder-scheduler-secret"])assert.ok(edge.includes(header),header);
  assert.match(edge,/if\(req\.method==="OPTIONS"\)return new Response\(null,\{status:204,headers:CORS\}\)/);
  assert.ok(edge.indexOf('req.method==="OPTIONS"')<edge.indexOf("req.json()"),"preflight precedes body parsing");
  assert.ok(edge.includes('if(req.method!=="POST")return json({error:"Method not allowed"},405)'));
  assert.ok(edge.includes("await requireAdministrator(user)"),"browser POST still requires administrator authorization");
  assert.ok(edge.includes('supplied!==expected)return json({error:"Unauthorized"},401)'),"scheduler POST still requires its secret");
  assert.ok(adapter.includes("restoreSessionPromise"),"Strict Mode auth restoration is deduplicated");
  assert.equal((adapter.match(/createClient\(/g)||[]).length,1,"one browser Supabase client is created");
  for(const text of ["response.clone().json()",'typeof body?.error==="string"','safeMessage||error.message'])assert.ok(adapter.includes(text),`safe Edge Function error handling includes ${text}`);
});
