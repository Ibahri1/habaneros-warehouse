/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";

const env = import.meta.env as Record<string, string | undefined>;
const url = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}) : null;

export const isSupabaseConfigured = Boolean(supabase);

function client() {
  if (!supabase) throw new Error("Supabase environment variables are not configured.");
  return supabase;
}

async function rpc<T>(name: string, params: Record<string, unknown> = {}) {
  const { data, error } = await client().rpc(name, params);
  if (error) throw error;
  return data as T;
}

export async function loginWithPin(pin: string) {
  const current = await client().auth.getSession();
  if (!current.data.session) {
    const { error } = await client().auth.signInAnonymously();
    if (error) throw error;
  }
  return rpc<{id:string;display_name:string;role:string}>("warehouse_login_with_pin", { input_pin: pin });
}

export async function restoreWarehouseSession() {
  const { data } = await client().auth.getSession();
  if (!data.session) return null;
  try { return await getWarehouseData(); } catch { return null; }
}

export async function logoutWarehouse() {
  try { await rpc("warehouse_logout"); } finally { await client().auth.signOut(); }
}

export async function getWarehouseData() {
  const data=await rpc<any>("warehouse_get_app_data");
  if(data?.user?.role!=="manager"){
    const hidden=await rpc<string[]>("warehouse_get_queue_hidden_orders");
    const hiddenIds=new Set(hidden||[]);
    data.orders=(data.orders||[]).map((order:any)=>({...order,queue_hidden:hiddenIds.has(order.id)}));
  }
  return data;
}

export const submitWarehouseOrder = (locationId:string, note:string, items:{product_id:string;quantity:number}[]) =>
  rpc<string>("warehouse_submit_order", { input_location_id:locationId, input_note:note, input_items:items });

export const updateWarehouseOrder = (orderId:string, status:string, fulfillmentNote:string, deliveryNote:string) =>
  rpc("warehouse_update_order", { input_order_id:orderId, input_status:status, input_fulfillment_note:fulfillmentNote, input_delivery_note:deliveryNote });

export const hideFinalizedOrdersFromQueue = (orderIds:string[]) =>
  rpc<number>("warehouse_hide_delivered_orders", { input_order_ids:orderIds });

export const bulkAdjustWarehouseInventory = (productIds:string[], quantity:number, reason:string) =>
  rpc<number>("warehouse_bulk_adjust_inventory", { input_product_ids:productIds, input_quantity:quantity, input_reason:reason });

export const saveWarehouseProduct = (value:any) => rpc<string>("warehouse_save_product", {
  input_id:value.id || null,
  input_category_id:value.category_id || null,
  input_name:value.name,
  input_sku:value.sku,
  input_description:value.description,
  input_unit_size:value.unit_size,
  input_low_stock_threshold:Number(value.low_stock_threshold || 0),
  input_image_path:value.image_path || null,
  input_item_location:value.item_location || null,
});

export const saveWarehouseCategory = (value:any) => rpc<string>("warehouse_save_category", {
  input_id:value.id || null, input_name:value.name, input_is_active:value.is_active,
});

export async function uploadWarehouseProductImage(file:File) {
  const extension=(file.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"");
  const path=`products/${crypto.randomUUID()}.${extension || "jpg"}`;
  const { error }=await client().storage.from("product-images").upload(path,file,{contentType:file.type,upsert:false});
  if(error)throw error;
  return path;
}

export async function removeWarehouseProductImage(path:string) {
  await client().storage.from("product-images").remove([path]);
}

export function productImageUrl(path?:string|null) {
  if(!path||!supabase)return "";
  return supabase.storage.from("product-images").getPublicUrl(path).data.publicUrl;
}

export async function deleteWarehouseProduct(id:string) {
  const imagePath=await rpc<string|null>("warehouse_delete_product", { input_id:id });
  if(imagePath){await client().storage.from("product-images").remove([imagePath]).catch(()=>undefined);}
}
export const deleteWarehouseCategory = (id:string) => rpc("warehouse_delete_category", { input_id:id });
export const deleteWarehouseLocation = (id:string) => rpc("warehouse_delete_location", { input_id:id });
export const deleteWarehouseUser = (id:string) => rpc("warehouse_delete_user", { input_id:id });

export const saveWarehouseLocation = (value:any) => rpc<string>("warehouse_save_location", {
  input_id:value.id || null, input_name:value.name, input_is_active:value.is_active,
});

export const saveWarehouseUser = (value:any) => rpc<string>("warehouse_save_user", {
  input_id:value.id || null,
  input_display_name:value.display_name,
  input_role:value.role,
  input_pin:value.pin || null,
  input_location_ids:value.role === "manager" ? value.location_ids || [] : [],
  input_all_locations:value.role === "manager" && Boolean(value.all_locations),
  input_is_active:value.is_active,
});

export const saveWarehouseSettings = (value:any) => rpc("warehouse_save_settings", {
  input_name:value.warehouse_name,
  input_low_stock:Number(value.default_low_stock || 0),
  input_show_images:value.show_images,
});
