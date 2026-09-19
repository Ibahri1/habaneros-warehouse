/* eslint-disable @typescript-eslint/no-explicit-any, jsx-a11y/label-has-associated-control, jsx-a11y/no-autofocus, jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, @next/next/no-img-element */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  adjustWarehouseInventory, deleteWarehouseCategory, deleteWarehouseLocation, deleteWarehouseProduct, deleteWarehouseUser,
  getWarehouseData, loginWithPin, logoutWarehouse,
  restoreWarehouseSession, saveWarehouseCategory, saveWarehouseLocation,
  saveWarehouseProduct, saveWarehouseSettings, saveWarehouseUser,
  submitWarehouseOrder, updateWarehouseOrder, uploadWarehouseProductImage, removeWarehouseProductImage, productImageUrl,
  getWarehouseReorderAdminData, saveWarehouseReorderSettings, invokeWarehouseReorderReport,
} from "@/lib/supabase";
import { consolidatePickingItems } from "@/lib/picking-list.mjs";

type Role = "manager" | "fulfillment" | "admin";
type View = "catalog" | "cart" | "history" | "dashboard" | "orders" | "orderHistory" | "products" | "categories" | "locations" | "adjustment" | "movements" | "users" | "settings" | "reorderReports";
type Product = {id:string;category_id:string|null;category:string|null;name:string;sku:string|null;description:string|null;unit_size:string|null;image_path:string|null;item_location:string|null;low_stock_threshold:number|null;is_active:boolean;is_archived:boolean;on_hand:number;reserved:number;available:number};
type Category = {id:string;name:string;is_active:boolean;sort_order:number};
type Location = {id:string;name:string;is_active:boolean;assigned?:boolean;sort_order:number};
type User = {id:string;display_name:string;role:Role;is_active:boolean;location_ids:string[];all_locations:boolean};
type OrderItem = {id:string;product_id:string|null;name:string;sku:string|null;unit_size:string|null;item_location:string|null;requested_quantity:number;delivered_quantity:number;cancelled_quantity:number;fulfillment_note:string|null};
type Order = {id:string;order_number:string;manager_id:string|null;manager:string;location_id:string|null;location:string;status:string;order_note:string|null;fulfillment_note:string|null;delivery_note:string|null;submitted_at:string;delivered_at:string|null;queue_hidden?:boolean;items:OrderItem[]};
type Movement = {id:string;product_id:string;product:string;quantity:number;action:string;reason:string;actor:string|null;created_at:string};
type AppData = {user:{id:string;display_name:string;role:Role};locations:Location[];categories:Category[];products:Product[];orders:Order[];movements:Movement[];users:User[];settings:Record<string,any>};

const statusClass = (s:string) => `status status-${s.toLowerCase().replaceAll(" ","-")}`;
const messageOf = (error:unknown) => error instanceof Error ? error.message : String((error as any)?.message || error || "Something went wrong");
const when = (value:string) => new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(value));
const fulfillmentViews:View[]=["orders"];
const activeOrderStatuses=new Set(["Submitted","Confirmed","Picking","Out for Delivery"]);
const isFinalizedOrder=(status:string)=>status==="Delivered"||status==="Cancelled";

export function WarehouseApp() {
  const [data,setData] = useState<AppData|null>(null);
  const [loading,setLoading] = useState(true);
  const [working,setWorking] = useState(false);
  const [view,setView] = useState<View>("catalog");
  const [pin,setPin] = useState("");
  const [toast,setToast] = useState("");
  const [selectedOrder,setSelectedOrder] = useState<Order|null>(null);
  const [cart,setCart] = useState<Record<string,number>>({});
  const [category,setCategory] = useState("All");
  const [search,setSearch] = useState("");
  const [location,setLocation] = useState("");
  const [note,setNote] = useState("");

  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),2800)};
  const refresh=async()=>{const next=await getWarehouseData();setData(next);setSelectedOrder(current=>current?next.orders.find((o:Order)=>o.id===current.id)||null:null);return next};
  const act=async<T,>(action:()=>Promise<T>,success?:string)=>{setWorking(true);try{const result=await action();await refresh();if(success)notify(success);return result}catch(error){notify(messageOf(error));throw error}finally{setWorking(false)}};

  useEffect(()=>{restoreWarehouseSession().then(saved=>{if(saved){setData(saved);setView(saved.user.role==="manager"?"catalog":saved.user.role==="fulfillment"?"orders":"dashboard")}}).finally(()=>setLoading(false))},[]);
  // Refresh periodically so a second device sees warehouse changes without reloading.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{if(!data)return;const timer=window.setInterval(()=>refresh().catch(()=>undefined),30000);return()=>window.clearInterval(timer)},[data?.user.id]);

  async function login(){
    if(pin.length!==4){notify("Enter a 4-digit code");return}
    setWorking(true);
    try{await loginWithPin(pin);const next=await refresh();setPin("");setView(next.user.role==="manager"?"catalog":next.user.role==="fulfillment"?"orders":"dashboard");notify(`Welcome, ${next.user.display_name}`)}
    catch(error){notify(messageOf(error))}finally{setWorking(false);setLoading(false)}
  }
  async function logout(){setWorking(true);try{await logoutWarehouse()}finally{setData(null);setPin("");setCart({});setSelectedOrder(null);setView("catalog");setWorking(false)}}
  function navigate(next:View){const allowed=data?.user.role!=="fulfillment"||fulfillmentViews.includes(next);setSelectedOrder(null);setView(allowed?next:"orders")}
  function changeQty(id:string,next:number){const product=data!.products.find(x=>x.id===id)!;setCart(current=>({...current,[id]:Math.max(0,Math.min(next,product.available))}))}
  async function submitOrder(){
    const items=Object.entries(cart).filter(([,quantity])=>quantity>0).map(([product_id,quantity])=>({product_id,quantity}));
    if(!location){notify("Choose a destination location");return}if(!items.length){notify("Add at least one product");return}
    try{await act(()=>submitWarehouseOrder(location,note,items),"Warehouse order submitted");setCart({});setNote("");setLocation("");navigate("history")}catch{return}
  }
  async function updateOrder(order:Order,status:string,fulfillmentNote:string,deliveryNote:string){
    if(status!==order.status&&(isFinalizedOrder(order.status)||isFinalizedOrder(status))&&!window.confirm(`Change this order from ${order.status} to ${status}? Inventory and reservations will be updated automatically.`))return;
    try{await act(()=>updateWarehouseOrder(order.id,status,fulfillmentNote,deliveryNote),status===order.status?"Order notes saved":`Order status changed to ${status}`);if(status!==order.status&&(isFinalizedOrder(order.status)||isFinalizedOrder(status))){setSelectedOrder(null);setView("orders")}}catch{return}
  }

  if(loading)return <main className="login-page"><section className="login-card loading-card"><BrandLogo/><h2>Opening warehouse...</h2></section></main>;
  if(!data)return <Login pin={pin} setPin={setPin} login={login} toast={toast} working={working}/>;

  const role=data.user.role;
  const safeView=role==="fulfillment"&&!fulfillmentViews.includes(view)?"orders":view;
  const cartCount=Object.values(cart).reduce((sum,qty)=>sum+qty,0);
  const managerNav:[View,string][]=[["catalog","Catalog"],["cart",`Cart${cartCount?` (${cartCount})`:""}`],["history","My Orders"]];
  const adminNav:[View,string][]=[["dashboard","Dashboard"],["orders","Order Queue"],["orderHistory","Order History"],["products","Products"],["categories","Categories"],["locations","Locations"],["adjustment","Adjust"],["movements","Movement Log"],["reorderReports","Reorder Reports"],["users","Employees & Codes"],["settings","Settings"]];
  const fulfillmentNav:[View,string][]=[["orders","Orders"]];
  const nav=role==="manager"?managerNav:role==="fulfillment"?fulfillmentNav:adminNav;
  return <div className={`app-shell ${working?"is-working":""}`} style={{"--print-logo":'url("./assets/habaneros-logo.png")'} as React.CSSProperties}>
    <header className="topbar"><button className="brand" onClick={()=>navigate(role==="manager"?"catalog":role==="fulfillment"?"orders":"dashboard")} aria-label="Habanero's Mexican Food warehouse home"><BrandLogo compact/></button><div className="account"><span className="account-copy"><b>{data.user.display_name}</b><small>{role==="manager"?"Store Manager":role==="admin"?"Administrator":"Fulfillment"}</small></span><button className="icon-button" onClick={logout} aria-label="Sign out">↪</button></div></header>
    <div className="body"><aside>{role!=="manager"&&<div className={`role-banner role-${role}`}>{role==="admin"?"Administrator":"Fulfillment"}</div>}<nav>{nav.map(([id,label])=><button key={id} className={safeView===id&&!selectedOrder?"active":""} onClick={()=>navigate(id)}><span>{navIcon(id)}</span>{label}</button>)}</nav><div className="warehouse-state"><span className="pulse"/>Warehouse online</div></aside>
    <main>{role==="manager"?<Manager data={data} view={safeView} navigate={navigate} selectedOrder={selectedOrder} setSelectedOrder={setSelectedOrder} cart={cart} changeQty={changeQty} cartCount={cartCount} category={category} setCategory={setCategory} search={search} setSearch={setSearch} location={location} setLocation={setLocation} note={note} setNote={setNote} submitOrder={submitOrder}/>:<Admin data={data} view={safeView} navigate={navigate} selectedOrder={selectedOrder} setSelectedOrder={setSelectedOrder} act={act} updateOrder={updateOrder}/>}</main></div>
    {toast&&<div className={`toast ${toast.toLowerCase().includes("invalid")||toast.toLowerCase().includes("required")?"error":""}`}>{toast}</div>}
  </div>;
}

function Login({pin,setPin,login,toast,working}:{pin:string;setPin:(v:string)=>void;login:()=>void;toast:string;working:boolean}){
  const inputRef=useRef<HTMLInputElement>(null);
  return <main className="login-page"><section className="login-card"><div className="login-brand"><BrandLogo/></div><p className="product-title">Warehouse Ordering</p><div className="rule"/><h2>Welcome back</h2><p>Enter your 4-digit warehouse access code.</p><label htmlFor="access-code">Access code</label><div className="pin-entry" onClick={()=>inputRef.current?.focus()}><div className="pin-boxes" aria-hidden="true">{[0,1,2,3].map(i=><span key={i}>{pin[i]?"•":""}</span>)}</div><input id="access-code" ref={inputRef} autoFocus className="pin-input" aria-label="4-digit access code" inputMode="numeric" autoComplete="one-time-code" maxLength={4} value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))} onKeyDown={e=>e.key==="Enter"&&login()}/></div><button className="primary wide" disabled={working} onClick={login}>{working?"Signing in...":"Continue"}</button><p className="help">Use the code assigned by your warehouse administrator.</p></section>{toast&&<div className="toast error">{toast}</div>}</main>
}

function BrandLogo({compact=false}:{compact?:boolean}){return <img className={compact?"brand-logo compact":"brand-logo"} src="./assets/habaneros-logo.png" alt="Habanero's Mexican Food"/>}

function Manager(p:any){
  const products=p.data.products.filter((x:Product)=>x.is_active&&!x.is_archived&&(p.category==="All"||x.category===p.category)&&(`${x.name} ${x.sku||""}`.toLowerCase().includes(p.search.toLowerCase())));
  const categories=["All",...p.data.categories.filter((x:Category)=>x.is_active).map((x:Category)=>x.name)];
  if(p.selectedOrder)return <OrderDetail order={p.selectedOrder} back={()=>p.setSelectedOrder(null)} manager/>;
  if(p.view==="catalog")return <><PageHead eyebrow="WAREHOUSE CATALOG" title="What does your store need?" subtitle="Choose products and quantities. Availability is shared with fulfillment."/><div className="toolbar"><div className="search">⌕ <input aria-label="Search products" placeholder="Search products or SKU" value={p.search} onChange={(e:any)=>p.setSearch(e.target.value)}/></div><div className="chips">{categories.map((name:string)=><button className={p.category===name?"selected":""} key={name} onClick={()=>p.setCategory(name)}>{name}</button>)}</div></div><div className="product-grid">{products.map((x:Product)=><ProductCard key={x.id} product={x} qty={p.cart[x.id]||0} change={p.changeQty}/>)}</div>{p.cartCount>0&&<button className="floating-cart" onClick={()=>p.navigate("cart")}><span>View cart</span><b>{p.cartCount} units →</b></button>}</>;
  if(p.view==="cart")return <><PageHead eyebrow="YOUR ORDER" title="Review warehouse order" subtitle="Adjust quantities before choosing a destination."/><div className="split"><section className="panel"><h3>Order items <span className="count">{p.cartCount}</span></h3>{Object.entries(p.cart).filter(([,q])=>(q as number)>0).map(([id,q])=>{const x=p.data.products.find((z:Product)=>z.id===id);return <div className="cart-row" key={id}><div className="product-icon small">□</div><div className="grow"><b>{x.name}</b><small>{x.sku} · {x.unit_size}</small></div><Qty value={q as number} max={x.available} onChange={(v:number)=>p.changeQty(x.id,v)}/><button className="remove" onClick={()=>p.changeQty(x.id,0)}>Remove</button></div>})}{!p.cartCount&&<Empty text="Your cart is empty." action="Browse catalog" onClick={()=>p.navigate("catalog")}/>}</section><SubmitPanel {...p}/></div></>;
  return <><PageHead eyebrow="ORDER HISTORY" title="Your warehouse orders" subtitle="Follow every order from submission through delivery."/><OrderList orders={p.data.orders} select={p.setSelectedOrder}/></>;
}

function ProductCard({product,qty,change}:{product:Product;qty:number;change:(id:string,q:number)=>void}){const image=productImageUrl(product.image_path);return <article className={`product-card ${product.available===0?"out":""}`}><div className="product-image">{image?<img src={image} alt=""/>:<span>□</span>}{product.available===0&&<b>OUT OF STOCK</b>}</div><div className="product-info"><div className="meta"><span>{product.category||"Uncategorized"}</span><span>{product.sku}</span></div><h3>{product.name}</h3><p>{product.description}</p><small>{product.unit_size}</small><div className="availability"><span className={product.low_stock_threshold!==null&&product.available<=product.low_stock_threshold?"low":""}>{product.available===0?"Unavailable":`${product.available} available`}</span>{product.available>0&&<Qty value={qty} max={product.available} onChange={value=>change(product.id,value)}/>}</div></div></article>}
function Qty({value,max,onChange}:{value:number;max:number;onChange:(v:number)=>void}){return <div className="qty"><button aria-label="Decrease quantity" onClick={()=>onChange(value-1)} disabled={value===0}>−</button><span>{value}</span><button aria-label="Increase quantity" onClick={()=>onChange(value+1)} disabled={value>=max}>+</button></div>}
function SubmitPanel(p:any){return <section className="panel submit-panel"><h3>Delivery details</h3><label>Destination location <b>*</b></label><select value={p.location} onChange={(e:any)=>p.setLocation(e.target.value)}><option value="">Select a location</option>{p.data.locations.filter((x:Location)=>x.is_active).map((x:Location)=><option key={x.id} value={x.id}>{x.name}</option>)}</select><label>Order note <span>Optional</span></label><textarea value={p.note} onChange={(e:any)=>p.setNote(e.target.value)} placeholder="Delivery instructions or details for fulfillment..."/><div className="summary"><span>Total units</span><b>{p.cartCount}</b></div><button className="primary wide" onClick={p.submitOrder}>Submit Warehouse Order</button><small className="center">Submitting reserves available warehouse inventory.</small></section>}

function Admin(p:any){
  const [editor,setEditor]=useState<{kind:"product"|"category"|"location"|"user";value:any}|null>(null);
  const [queueSearch,setQueueSearch]=useState("");
  const [productSearch,setProductSearch]=useState("");
  const [productCategory,setProductCategory]=useState("all");
  const [categorySearch,setCategorySearch]=useState("");
  const [locationSearch,setLocationSearch]=useState("");
  const save=async(kind:string,value:any)=>{
    const calls:any={product:saveWarehouseProduct,category:saveWarehouseCategory,location:saveWarehouseLocation,user:saveWarehouseUser};
    const payload={...value};
    const oldImage=payload.image_path as string|null|undefined;
    let uploadedImage:string|null=null;
    if(kind==="user"||kind==="location")payload.is_active=true;
    try{
      await p.act(async()=>{
        if(kind==="product"&&payload._imageFile){
          uploadedImage=await uploadWarehouseProductImage(payload._imageFile);
          payload.image_path=uploadedImage;
        }
        await calls[kind](payload);
      },`${kind[0].toUpperCase()+kind.slice(1)} saved`);
    }catch(error){
      // Avoid orphaning a newly uploaded image when the product write fails.
      if(uploadedImage)await removeWarehouseProductImage(uploadedImage).catch(()=>undefined);
      throw error;
    }
    // Keep the previous image until both the replacement upload and product write succeed.
    if(kind==="product"&&oldImage&&uploadedImage&&oldImage!==uploadedImage)removeWarehouseProductImage(oldImage).catch(()=>undefined);
    setEditor(null);
  };
  const remove=async(kind:"product"|"category"|"location"|"user",value:any)=>{const display=value.name||value.display_name;if(!window.confirm(`Permanently delete ${display}? This cannot be undone.`))return;const actions:any={product:deleteWarehouseProduct,category:deleteWarehouseCategory,location:deleteWarehouseLocation,user:deleteWarehouseUser};try{await p.act(()=>actions[kind](value.id),`${kind[0].toUpperCase()+kind.slice(1)} deleted`)}catch{return}};
  if(p.selectedOrder)return <OrderDetail order={p.selectedOrder} back={()=>p.setSelectedOrder(null)} update={(status:string,fulfillment:string,delivery:string)=>p.updateOrder(p.selectedOrder,status,fulfillment,delivery)}/>;
  const open=(kind:any,value:any={})=>setEditor({kind,value});
  const matchingProducts=p.data.products.filter((x:Product)=>`${x.name} ${x.sku||""} ${x.unit_size||""}`.toLowerCase().includes(productSearch.trim().toLowerCase())&&(productCategory==="all"?true:productCategory==="uncategorized"?!x.category_id:x.category_id===productCategory));
  const matchingCategories=p.data.categories.filter((x:Category)=>x.name.toLowerCase().includes(categorySearch.trim().toLowerCase()));
  const matchingLocations=p.data.locations.filter((x:Location)=>x.name.toLowerCase().includes(locationSearch.trim().toLowerCase()));
  let content:React.ReactNode;
  if(p.view==="dashboard")content=<Dashboard data={p.data} navigate={p.navigate} select={p.setSelectedOrder}/>;
  else if(p.view==="orders"){const orders=p.data.orders.filter((o:Order)=>activeOrderStatuses.has(o.status)).filter((o:Order)=>`${o.order_number} ${o.manager} ${o.location} ${o.status}`.toLowerCase().includes(queueSearch.toLowerCase()));content=<><div className="queue-screen no-print"><PageHead eyebrow="FULFILLMENT" title={p.data.user.role==="fulfillment"?"Orders":"Order queue"} subtitle="Submitted, confirmed, picking, and out-for-delivery orders appear here." action={<button className="secondary" onClick={()=>window.print()}>Print picking list</button>}/><div className="filters"><div className="search">⌕ <input placeholder="Search order, location, manager..." value={queueSearch} onChange={e=>setQueueSearch(e.target.value)}/></div></div><OrderList orders={orders} select={p.setSelectedOrder}/></div><PickingList orders={orders} products={p.data.products}/></>}
  else if(p.view==="orderHistory"){const orders=p.data.orders.filter((o:Order)=>isFinalizedOrder(o.status)).filter((o:Order)=>`${o.order_number} ${o.manager} ${o.location} ${o.status}`.toLowerCase().includes(queueSearch.toLowerCase()));content=<><PageHead eyebrow="FULFILLMENT" title="Order history" subtitle="Delivered and Cancelled orders appear here immediately with their complete details."/><div className="filters"><div className="search">⌕ <input placeholder="Search order, location, manager..." value={queueSearch} onChange={e=>setQueueSearch(e.target.value)}/></div></div><OrderList orders={orders} select={p.setSelectedOrder}/></>}
  else if(p.view==="products")content=<Management title="Product management" subtitle="Add, edit, and permanently delete warehouse products." button="Add product" onAdd={()=>open("product")}><ListToolbar search={productSearch} setSearch={setProductSearch} placeholder="Search products, SKU, or unit"><label className="category-filter">Category<select aria-label="Filter products by category" value={productCategory} onChange={e=>setProductCategory(e.target.value)}><option value="all">All categories</option>{p.data.categories.map((x:Category)=><option key={x.id} value={x.id}>{x.name}</option>)}<option value="uncategorized">Uncategorized</option></select></label></ListToolbar><div className="responsive-table product-table"><div className="table-head"><span>Product</span><span>Category</span><span>Item location</span><span>On hand</span><span>Reserved</span><span>Available</span><span></span></div>{matchingProducts.map((x:Product)=><div className="table-row" key={x.id}><span data-label="Product" className="product-list-name">{x.image_path?<img src={productImageUrl(x.image_path)} alt=""/>:<span className="product-thumb-placeholder">□</span>}<span><b>{x.name}</b><small>{x.sku} · {x.unit_size}</small></span></span><span data-label="Category">{x.category||"Uncategorized"}</span><span data-label="Item location">{x.item_location||"—"}</span><span data-label="On hand">{x.on_hand}</span><span data-label="Reserved">{x.reserved}</span><span data-label="Available"><b className={x.available<=x.low_stock_threshold?"danger-text":""}>{x.available}</b></span><span className="row-actions"><button className="secondary" onClick={()=>open("product",x)}>Edit</button>{p.data.user.role==="admin"&&<button className="danger-button" onClick={()=>remove("product",x)}>Delete</button>}</span></div>)}{!matchingProducts.length&&<p className="empty-copy list-empty">No products match your search and category filter.</p>}</div></Management>;
  else if(p.view==="categories")content=<Management title="Categories" subtitle="Keep the manager catalog organized." button="Add category" onAdd={()=>open("category")}><ListToolbar search={categorySearch} setSearch={setCategorySearch} placeholder="Search categories"/><SimpleRows rows={matchingCategories} label={(x:any)=>x.name} detail={(x:any)=>`${p.data.products.filter((product:Product)=>product.category_id===x.id).length} products`} edit={(x:any)=>open("category",x)} remove={p.data.user.role==="admin"?(x:any)=>remove("category",x):undefined}/>{!matchingCategories.length&&<p className="empty-copy">No categories match your search.</p>}</Management>;
  else if(p.view==="locations")content=<Management title="Locations" subtitle="Manage manager destinations." button="Add location" onAdd={()=>open("location")}><ListToolbar search={locationSearch} setSearch={setLocationSearch} placeholder="Search locations"/><SimpleRows rows={matchingLocations} label={(x:any)=>x.name} detail={(x:any)=>`${p.data.orders.filter((order:Order)=>order.location_id===x.id).length} orders`} edit={(x:any)=>open("location",x)} remove={p.data.user.role==="admin"?(x:any)=>remove("location",x):undefined}/>{!matchingLocations.length&&<p className="empty-copy">No locations match your search.</p>}</Management>;
  else if(p.view==="adjustment")content=<InventoryForm data={p.data} act={p.act}/>;
  else if(p.view==="movements")content=<MovementLog movements={p.data.movements}/>;
  else if(p.view==="reorderReports")content=<ReorderReports/>;
  else if(p.view==="users")content=<Management title="Employees & access codes" subtitle="Add, reset, or permanently delete employee access." button="Add employee" onAdd={()=>open("user")}><SimpleRows rows={p.data.users} label={(x:any)=>x.display_name} detail={(x:any)=>x.role==="manager"?`${x.role} · ${x.all_locations?"All locations":x.location_ids.map((id:string)=>p.data.locations.find((l:Location)=>l.id===id)?.name).filter(Boolean).join(", ")||"No locations"}`:`${x.role} · Warehouse`} edit={(x:any)=>open("user",x)} remove={(x:any)=>remove("user",x)}/><div className="security-note">PINs are one-way hashed. Leave the PIN blank when editing to keep the current code. Managers marked All locations automatically receive access to newly added active locations.</div></Management>;
  else content=<Settings data={p.data} act={p.act}/>;
  return <>{content}{editor&&<EditorModal editor={editor} categories={p.data.categories} locations={p.data.locations} close={()=>setEditor(null)} save={save}/>}</>;
}

function Dashboard({data,navigate,select}:{data:AppData;navigate:(v:View)=>void;select:(o:Order)=>void}){
  const count=(status:string)=>data.orders.filter(o=>o.status===status).length;
  const low=data.products.filter(x=>x.low_stock_threshold!==null&&x.available<=x.low_stock_threshold);
  return <><PageHead eyebrow="FULFILLMENT OVERVIEW" title={`Good morning, ${data.user.display_name}`} subtitle="Here is what needs attention at the warehouse." action={<button className="primary" onClick={()=>navigate("orders")}>Open order queue →</button>}/><div className="stats"><Stat n={String(data.orders.filter(o=>!["Delivered","Cancelled"].includes(o.status)).length)} label="Pending orders" tone="orange"/><Stat n={String(count("Picking"))} label="Currently picking" tone="blue"/><Stat n={String(count("Out for Delivery"))} label="Out for delivery" tone="purple"/><Stat n={String(low.length)} label="Low-stock alerts" tone="red"/></div><div className="dashboard-grid"><section className="panel wide-panel"><PanelTitle title="Recently submitted" action="View queue" onClick={()=>navigate("orders")}/><OrderRows orders={data.orders.slice(0,4)} select={select}/></section><section className="panel"><PanelTitle title="Low stock" action="Manage" onClick={()=>navigate("products")}/>{low.slice(0,5).map(x=><div className="stock-row" key={x.id}><div className="product-icon small">□</div><div className="grow"><b>{x.name}</b><small>{x.sku}</small></div><strong>{x.available}</strong></div>)}</section><section className="panel"><PanelTitle title="Recent adjustments" action="Movement log" onClick={()=>navigate("movements")}/>{data.movements.slice(0,3).map(x=><div className="audit-row" key={x.id}><span>{x.quantity>0?"+":""}{x.quantity}</span><div><b>{x.product}</b><small>{x.reason}</small></div></div>)}</section></div></>;
}

function OrderDetail({order,back,manager,update}:{order:Order;back:()=>void;manager?:boolean;update?:(s:string,f:string,d:string)=>void}){
  const [fulfillment,setFulfillment]=useState(order.fulfillment_note||"");
  const [delivery,setDelivery]=useState(order.delivery_note||"");
  const pickedKey=`warehouse-picked-items:${order.id}`;
  const [pickedItems,setPickedItems]=useState<string[]>(()=>{if(manager)return [];try{const saved=JSON.parse(window.localStorage.getItem(pickedKey)||"[]");return Array.isArray(saved)?saved.filter(id=>order.items.some(item=>item.id===id)):[]}catch{return []}});
  const togglePicked=(id:string)=>setPickedItems(current=>{const next=current.includes(id)?current.filter(value=>value!==id):[...current,id];try{if(next.length)window.localStorage.setItem(pickedKey,JSON.stringify(next));else window.localStorage.removeItem(pickedKey)}catch{return next}return next});
  return <div className="print-area"><button className="back no-print" onClick={back}>← Back to orders</button><PageHead eyebrow={order.order_number} title={`${order.location} order`} subtitle={`Submitted by ${order.manager} · ${when(order.submitted_at)}`} action={<span className={statusClass(order.status)}>{order.status}</span>}/><div className="split"><section className="panel"><h3>Picking & packing details</h3>{order.items.map(x=>{const picked=pickedItems.includes(x.id);return <div className={`pick-row ${picked?"is-picked":""}`} key={x.id}>{!manager&&<label className="pick-check no-print"><input type="checkbox" checked={picked} onChange={()=>togglePicked(x.id)}/><span>Picked</span></label>}<span className="pick-requested"><b>{x.requested_quantity}</b><small>requested</small></span><div className="grow"><b>{x.name}</b><small>{x.sku} · {x.unit_size}</small>{!manager&&<span className="item-location">Item Location: {x.item_location||"Not set"}</span>}</div></div>})}{!manager&&<div className="screen-notes"><label>Fulfillment notes<textarea value={fulfillment} onChange={e=>setFulfillment(e.target.value)} placeholder="Substitutions, shortages, or packing notes..."/></label><label>Delivery note<textarea value={delivery} onChange={e=>setDelivery(e.target.value)} placeholder="Where and to whom the order was delivered..."/></label></div>}<div className="print-only print-notes"><h3>Order notes</h3><div><b>Manager note</b><p>{order.order_note||"None"}</p></div><div><b>Fulfillment note</b><p>{fulfillment||"None"}</p></div><div><b>Delivery note</b><p>{delivery||"None"}</p></div></div></section><section className="panel order-side"><h3>Order details</h3><dl><div><dt>Destination</dt><dd>{order.location}</dd></div><div><dt>Manager</dt><dd>{order.manager}</dd></div><div><dt>Items</dt><dd>{order.items.length}</dd></div><div><dt>Order note</dt><dd>{order.order_note||"None"}</dd></div></dl>{!manager&&<><label>Update status</label><div className="status-actions">{["Confirmed","Picking","Out for Delivery","Delivered","Cancelled"].map(status=><button key={status} className={order.status===status?"primary":"secondary"} onClick={()=>update?.(status,fulfillment,delivery)}>{status}</button>)}</div><button className="secondary wide" onClick={()=>update?.(order.status,fulfillment,delivery)}>Save notes</button><button className="print-button" onClick={()=>window.print()}>Print picking list</button></>}</section></div></div>;
}

function InventoryForm({data,act}:{data:AppData;act:any}){
  const [selected,setSelected]=useState<Product|null>(null);const [pending,setPending]=useState(0);const [reason,setReason]=useState("Inventory adjustment");const [search,setSearch]=useState("");const [adding,setAdding]=useState(false);const [addQuantity,setAddQuantity]=useState("");const [error,setError]=useState("");const [saving,setSaving]=useState(false);const [exitRequested,setExitRequested]=useState(false);
  const products=data.products.filter(x=>`${x.name} ${x.sku||""} ${x.unit_size||""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const proposedOnHand=selected?selected.on_hand+pending:0;const proposedAvailable=selected?proposedOnHand-selected.reserved:0;
  useEffect(()=>{if(!selected||pending===0)return;const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=""};const guardNavigation=(event:MouseEvent)=>{const target=event.target as HTMLElement|null;if(target?.closest("aside nav button,.brand")){event.preventDefault();event.stopPropagation();setExitRequested(true)}};window.addEventListener("beforeunload",beforeUnload);document.addEventListener("click",guardNavigation,true);return()=>{window.removeEventListener("beforeunload",beforeUnload);document.removeEventListener("click",guardNavigation,true)}},[selected,pending]);
  const openProduct=(product:Product)=>{setSelected(product);setPending(0);setReason("Inventory adjustment");setError("");setAdding(false);setExitRequested(false)};
  const requestClose=()=>{if(pending!==0)setExitRequested(true);else setSelected(null)};
  const discard=()=>{setPending(0);setSelected(null);setAdding(false);setExitRequested(false);setError("")};
  const subtractOne=()=>{if(!selected)return;if(proposedOnHand-1<selected.reserved){setError("On-hand inventory cannot fall below reserved inventory.");return}setError("");setPending(value=>value-1)};
  const addUnits=()=>{const amount=Number(addQuantity);if(!Number.isInteger(amount)||amount<=0){setError("Enter a positive whole-number quantity to add.");return}setPending(value=>value+amount);setAddQuantity("");setAdding(false);setError("")};
  const save=async()=>{if(!selected||pending===0||saving)return;if(!reason.trim()){setError("Adjustment reason is required.");return}setSaving(true);setError("");try{await act(()=>adjustWarehouseInventory(selected.id,pending,reason),`${selected.name} inventory adjusted`);setPending(0);setSelected(null)}catch(saveError){setError(messageOf(saveError))}finally{setSaving(false)}};
  if(selected)return <><button className="back" onClick={requestClose}>← Back to products</button><PageHead eyebrow="INVENTORY ADJUSTMENT" title={selected.name} subtitle={`${selected.sku||"No SKU"} · ${selected.unit_size||"Unit size not set"}`}/><section className="panel inventory-adjustment-detail" aria-busy={saving}><div className="available-label">Available inventory</div><div className="inventory-stepper"><button type="button" aria-label="Subtract one" onClick={subtractOne} disabled={saving||proposedOnHand<=selected.reserved}>−</button><strong>{proposedAvailable}</strong><button type="button" aria-label="Add inventory" onClick={()=>{setAdding(true);setError("")}} disabled={saving}>+</button></div>{adding&&<div className="add-quantity-box"><label>How many units should be added?<input autoFocus type="number" min="1" step="1" inputMode="numeric" value={addQuantity} onChange={e=>setAddQuantity(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addUnits()}/></label><div><button className="secondary" onClick={()=>{setAdding(false);setAddQuantity("");setError("")}}>Cancel</button><button className="primary" onClick={addUnits}>Add</button></div></div>}<label>Adjustment reason<input value={reason} onChange={e=>{setReason(e.target.value);setError("")}} placeholder="Required reason"/></label><div className="inventory-comparison"><div><span></span><b>Original</b><b>After change</b></div><div><span>On hand</span><strong>{selected.on_hand}</strong><strong>{proposedOnHand}</strong></div><div><span>Reserved / committed</span><strong>{selected.reserved}</strong><strong>{selected.reserved}</strong></div><div className="available-row"><span>Available</span><strong>{selected.available}</strong><strong>{proposedAvailable}</strong></div></div>{pending!==0&&<p className="pending-change">Pending net adjustment: <b>{pending>0?"+":""}{pending}</b>. Nothing is saved until you choose Save.</p>}{error&&<div className="inline-error" role="alert">{error}</div>}{exitRequested&&<div className="discard-choice" role="alert"><b>You have an unsaved inventory adjustment.</b><span>Save it or discard it before leaving this screen.</span><div><button className="secondary" onClick={()=>setExitRequested(false)}>Keep editing</button><button className="danger-button" onClick={discard}>Discard</button><button className="primary" disabled={saving||pending===0} onClick={save}>{saving?"Saving…":"Save"}</button></div></div>}<div className="inventory-actions"><button className="secondary" disabled={saving} onClick={requestClose}>{pending===0?"Cancel":"Discard / Cancel"}</button><button className="primary" disabled={saving||pending===0||!reason.trim()} onClick={save}>{saving?"Saving…":"Save adjustment"}</button></div></section></>;
  return <><PageHead eyebrow="INVENTORY" title="Adjust inventory" subtitle="Choose a product to review its available inventory and make an adjustment."/><section className="panel inventory-product-panel"><ListToolbar search={search} setSearch={setSearch} placeholder="Search products or SKU"/><div className="inventory-product-list">{products.map(product=><button className="inventory-product-row" key={product.id} onClick={()=>openProduct(product)}><span className="inventory-product-thumb">{product.image_path?<img src={productImageUrl(product.image_path)} alt=""/>:"□"}</span><span><b>{product.name}</b><small>{product.unit_size||"Unit size not set"}{product.sku?` · ${product.sku}`:""}</small></span><strong aria-label={`${product.available} available`}>{product.available}<small>Available</small></strong></button>)}{!products.length&&<p className="empty-copy">No products match your search.</p>}</div></section></>;
}

function EditorModal({editor,categories,locations,close,save}:{editor:any;categories:Category[];locations:Location[];close:()=>void;save:(kind:string,value:any)=>Promise<void>}){
  const activeLocations=locations.filter(location=>location.is_active);
  const defaults:any={product:{name:"",sku:"",category_id:categories[0]?.id||null,description:"",unit_size:"",item_location:"",image_path:null,low_stock_threshold:8},category:{name:"",is_active:true},location:{name:"",is_active:true},user:{display_name:"",role:"manager",pin:"",location_ids:activeLocations[0]?[activeLocations[0].id]:[],all_locations:false,is_active:true}};
  const [value,setValue]=useState({...defaults[editor.kind],...editor.value,...(editor.kind==="user"?{location_ids:editor.value.location_ids||(editor.value.location_id?[editor.value.location_id]:defaults.user.location_ids),all_locations:Boolean(editor.value.all_locations)}:{}),pin:""});
  const [saving,setSaving]=useState(false);
  const [formError,setFormError]=useState("");
  const set=(key:string,next:any)=>{setFormError("");setValue((current:any)=>({...current,[key]:next}))};
  const submit=async()=>{
    setFormError("");
    const name=(value.name||value.display_name||"").trim();
    if(!name){setFormError(`${editor.kind==="user"?"Display name":`${editor.kind[0].toUpperCase()+editor.kind.slice(1)} name`} is required.`);return}
    if(editor.kind==="user"&&!editor.value.id&&value.pin.length!==4){setFormError("Enter a 4-digit access code.");return}
    if(editor.kind==="user"&&value.role==="manager"&&!value.all_locations&&!value.location_ids.length){setFormError("Select at least one manager location or choose All locations.");return}
    if(editor.kind==="product"&&value._imageError){setFormError(value._imageError);return}
    setSaving(true);
    try{await save(editor.kind,value)}catch(error){setFormError(messageOf(error))}finally{setSaving(false)}
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(!saving&&e.target===e.currentTarget)close()}}><section className="modal" role="dialog" aria-modal="true" aria-busy={saving}>
    <div className="modal-head"><h2>{editor.value.id?"Edit":"Add"} {editor.kind}</h2><button className="icon-button" disabled={saving} onClick={close} aria-label="Close">×</button></div>
    <div className="modal-form">
      {editor.kind==="product"&&<>
        <label>Name<input value={value.name} onChange={e=>set("name",e.target.value)}/></label>
        <div className="form-grid"><label>SKU<input value={value.sku||""} onChange={e=>set("sku",e.target.value)}/></label><label>Category<select value={value.category_id||""} onChange={e=>set("category_id",e.target.value)}>{categories.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div>
        <label>Description<textarea value={value.description||""} onChange={e=>set("description",e.target.value)}/></label>
        <div className="form-grid"><label>Unit size<input value={value.unit_size||""} onChange={e=>set("unit_size",e.target.value)}/></label><label>Item Location <span className="optional">Optional</span><input value={value.item_location||""} onChange={e=>set("item_location",e.target.value)} placeholder="Example: Aisle 2, Shelf B"/></label></div>
        <label>Low-stock threshold <span>Optional</span><input type="number" min="0" value={value.low_stock_threshold??""} placeholder="Unset" onChange={e=>set("low_stock_threshold",e.target.value)}/></label>
        <ProductImageUpload currentPath={value.image_path} file={value._imageFile} disabled={saving} product={value} onFile={file=>set("_imageFile",file)} onError={error=>set("_imageError",error)}/>
        {value._imageError&&<div className="field-error" role="alert">{value._imageError}</div>}
      </>}
      {(editor.kind==="category"||editor.kind==="location")&&<label>Name<input autoFocus value={value.name} onChange={e=>set("name",e.target.value)}/></label>}
      {editor.kind==="user"&&<><label>Display name<input value={value.display_name} onChange={e=>set("display_name",e.target.value)}/></label><div className="form-grid"><label>Role<select value={value.role} onChange={e=>set("role",e.target.value)}><option value="manager">Manager</option><option value="fulfillment">Fulfillment</option><option value="admin">Administrator</option></select></label><label>{editor.value.id?"New 4-digit code (optional)":"4-digit code"}<input inputMode="numeric" maxLength={4} value={value.pin} onChange={e=>set("pin",e.target.value.replace(/\D/g,"").slice(0,4))}/></label></div>{value.role==="manager"&&<fieldset className="location-picker"><legend>Manager locations <span>Select all that apply</span></legend><label className="check-row all-locations"><input type="checkbox" checked={value.all_locations} onChange={e=>{const checked=e.target.checked;setValue((current:any)=>({...current,all_locations:checked,location_ids:checked?activeLocations.map(x=>x.id):current.location_ids}));setFormError("")}}/> All locations</label><div className="location-checklist">{activeLocations.map(location=><label className="check-row" key={location.id}><input type="checkbox" disabled={value.all_locations} checked={value.all_locations||value.location_ids.includes(location.id)} onChange={()=>set("location_ids",value.location_ids.includes(location.id)?value.location_ids.filter((id:string)=>id!==location.id):[...value.location_ids,location.id])}/><span>{location.name}</span></label>)}</div><small>{value.all_locations?"New active locations will be included automatically.":`${value.location_ids.length} location${value.location_ids.length===1?"":"s"} selected.`}</small></fieldset>}</>}
      {editor.kind==="category"&&<label className="check-row"><input type="checkbox" checked={value.is_active} onChange={e=>set("is_active",e.target.checked)}/> Active</label>}
    </div>
    {formError&&<div className="form-error" role="alert">{formError}</div>}
    <div className="modal-actions"><button className="secondary" disabled={saving} onClick={close}>Cancel</button><button className="primary" disabled={saving} onClick={submit}>{saving?(value._imageFile?"Uploading & saving…":"Saving…"):"Save"}</button></div>
  </section></div>;
}

function drawProductCrop(canvas:HTMLCanvasElement,image:HTMLImageElement,zoom:number,rotation:number,offset:{x:number;y:number}){
  const context=canvas.getContext("2d");if(!context)return;
  const ratio=canvas.width/600;
  const turns=((rotation%360)+360)%360;
  const rotated=turns===90||turns===270;
  const rotatedWidth=rotated?image.naturalHeight:image.naturalWidth;
  const rotatedHeight=rotated?image.naturalWidth:image.naturalHeight;
  const scale=Math.max(canvas.width/rotatedWidth,canvas.height/rotatedHeight)*zoom;
  context.clearRect(0,0,canvas.width,canvas.height);
  context.save();
  context.translate(canvas.width/2+offset.x*ratio,canvas.height/2+offset.y*ratio);
  context.rotate(rotation*Math.PI/180);
  context.scale(scale,scale);
  context.drawImage(image,-image.naturalWidth/2,-image.naturalHeight/2);
  context.restore();
}

function ProductImageUpload({currentPath,file,disabled,onFile,onError,product}:{currentPath?:string|null;file?:File;disabled?:boolean;onFile:(file:File)=>void;onError:(error:string)=>void;product:any}){
  const [source,setSource]=useState<File|null>(null);
  const [sourceUrl,setSourceUrl]=useState("");
  const [image,setImage]=useState<HTMLImageElement|null>(null);
  const [tab,setTab]=useState<"crop"|"preview">("crop");
  const [zoom,setZoom]=useState(1);
  const [rotation,setRotation]=useState(0);
  const [offset,setOffset]=useState({x:0,y:0});
  const [processing,setProcessing]=useState(false);
  const [dragStart,setDragStart]=useState<{x:number;y:number;ox:number;oy:number}|null>(null);
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const sourceUrlRef=useRef("");
  const onErrorRef=useRef(onError);
  const appliedUrl=useMemo(()=>file?URL.createObjectURL(file):productImageUrl(currentPath),[file,currentPath]);

  useEffect(()=>{onErrorRef.current=onError},[onError]);
  useEffect(()=>{if(!sourceUrl)return;const next=new Image();next.onload=()=>setImage(next);next.onerror=()=>onErrorRef.current("This image could not be opened. Choose another JPG, PNG, WebP, or GIF.");next.src=sourceUrl},[sourceUrl]);
  useEffect(()=>()=>{if(sourceUrlRef.current)URL.revokeObjectURL(sourceUrlRef.current)},[]);
  useEffect(()=>{if(image&&canvasRef.current)drawProductCrop(canvasRef.current,image,zoom,rotation,offset)},[image,zoom,rotation,offset,tab]);
  useEffect(()=>{if(!file)return;return()=>URL.revokeObjectURL(appliedUrl)},[file,appliedUrl]);

  const accept=(files:FileList|null)=>{const next=files?.[0];if(!next)return;const supported=["image/jpeg","image/png","image/webp","image/gif"];if(!supported.includes(next.type)){onError("Use a JPG, PNG, WebP, or GIF image.");return}if(next.size>6*1024*1024){onError("Image must be 6 MB or smaller.");return}if(sourceUrlRef.current)URL.revokeObjectURL(sourceUrlRef.current);const url=URL.createObjectURL(next);sourceUrlRef.current=url;setSourceUrl(url);setSource(next);setImage(null);setZoom(1);setRotation(0);setOffset({x:0,y:0});setTab("crop");onError("Adjust the image and choose Apply crop before saving.")};
  const reset=()=>{setZoom(1);setRotation(0);setOffset({x:0,y:0})};
  const applyCrop=async()=>{if(!image)return;setProcessing(true);onError("");try{const output=document.createElement("canvas");output.width=1200;output.height=720;drawProductCrop(output,image,zoom,rotation,offset);const blob=await new Promise<Blob|null>(resolve=>output.toBlob(resolve,"image/webp",.84));if(!blob)throw new Error("The browser could not create the cropped image.");const processed=new File([blob],`${source?.name.replace(/\.[^.]+$/,"")||"product"}-cropped.webp`,{type:"image/webp"});onFile(processed);setTab("preview")}catch(error){onError(messageOf(error))}finally{setProcessing(false)}};
  const pointerDown=(event:React.PointerEvent<HTMLCanvasElement>)=>{if(disabled)return;event.currentTarget.setPointerCapture(event.pointerId);setDragStart({x:event.clientX,y:event.clientY,ox:offset.x,oy:offset.y})};
  const pointerMove=(event:React.PointerEvent<HTMLCanvasElement>)=>{if(!dragStart)return;const rect=event.currentTarget.getBoundingClientRect();setOffset({x:dragStart.ox+(event.clientX-dragStart.x)*600/rect.width,y:dragStart.oy+(event.clientY-dragStart.y)*360/rect.height})};
  const pointerUp=()=>setDragStart(null);

  return <div className={`image-editor ${disabled?"disabled":""}`}>
    <div className="image-upload" onDragOver={e=>{e.preventDefault();if(!disabled)e.currentTarget.classList.add("dragging")}} onDragLeave={e=>e.currentTarget.classList.remove("dragging")} onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");if(!disabled)accept(e.dataTransfer.files)}}>
      {appliedUrl?<img src={appliedUrl} alt="Current product"/>:<span className="image-upload-icon">▧</span>}
      <div><b>Product picture</b><p>Drag and drop a JPG, PNG, WebP, or GIF (up to 6 MB), or browse your camera roll/files.</p>{source&&<small className="selected-file">Editing: {source.name}</small>}<label className="secondary file-button">{currentPath||file?"Replace image":"Choose image"}<input type="file" disabled={disabled} accept="image/jpeg,image/png,image/webp,image/gif" onChange={e=>accept(e.target.files)}/></label></div>
    </div>
    {sourceUrl&&<div className="image-workspace">
      <div className="image-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab==="crop"} className={tab==="crop"?"active":""} onClick={()=>setTab("crop")}>Resize &amp; Crop</button><button type="button" role="tab" aria-selected={tab==="preview"} className={tab==="preview"?"active":""} onClick={()=>setTab("preview")}>Product Preview</button></div>
      {tab==="crop"?<div className="crop-panel">
        <div className="crop-stage"><canvas ref={canvasRef} width="600" height="360" aria-label="Product image crop area" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}/><span>Drag image to reposition</span></div>
        <div className="crop-controls"><button type="button" className="secondary" onClick={()=>setZoom(value=>Math.max(1,Math.round((value-.1)*10)/10))} disabled={disabled||zoom<=1}>− Zoom out</button><button type="button" className="secondary" onClick={()=>setZoom(value=>Math.min(3,Math.round((value+.1)*10)/10))} disabled={disabled||zoom>=3}>+ Zoom in</button><button type="button" className="secondary" onClick={()=>setRotation(value=>value-90)} disabled={disabled}>↶ Rotate left</button><button type="button" className="secondary" onClick={()=>setRotation(value=>value+90)} disabled={disabled}>↷ Rotate right</button><button type="button" className="secondary" onClick={reset} disabled={disabled}>Reset</button><button type="button" className="primary" onClick={applyCrop} disabled={disabled||processing||!image}>{processing?"Applying…":"Apply crop"}</button></div>
      </div>:<ProductImageCardPreview image={appliedUrl} product={product}/>}</div>}
  </div>;
}

function ProductImageCardPreview({image,product}:{image:string;product:any}){return <div className="product-preview-wrap"><article className="product-card preview-card"><div className="product-image">{image?<img src={image} alt="Cropped product preview"/>:<span>□</span>}</div><div className="product-info"><div className="meta"><span>{product.category||"Category"}</span><span>{product.sku||"SKU"}</span></div><h3>{product.name||"Product name"}</h3><p>{product.description||"Product description will appear here."}</p><small>{product.unit_size||"Unit size"}</small><div className="availability"><span>24 available</span><div className="qty" aria-label="Quantity preview"><button type="button" disabled>−</button><span>0</span><button type="button" disabled>+</button></div></div></div></article><p>This is how the applied crop behaves in the manager catalog. The card scales to phone width without changing the crop.</p></div>}

function Settings({data,act}:{data:AppData;act:any}){const [value,setValue]=useState({warehouse_name:data.settings.warehouse_name||"Habaneros Central Warehouse",default_low_stock:data.settings.default_low_stock??8,show_images:data.settings.show_images??true});const set=(key:string,next:any)=>setValue(current=>({...current,[key]:next}));return <Management title="Warehouse settings" subtitle="Configure ordering and stock alerts."><div className="settings-form"><label>Warehouse display name<input value={value.warehouse_name} onChange={e=>set("warehouse_name",e.target.value)}/></label><label>Default low-stock threshold<input type="number" min="0" value={value.default_low_stock} onChange={e=>set("default_low_stock",e.target.value)}/></label><label className="toggle-row"><span><b>Show product images</b><small>Display stored product images in the catalog</small></span><input type="checkbox" checked={value.show_images} onChange={e=>set("show_images",e.target.checked)}/></label><button className="primary" onClick={()=>act(()=>saveWarehouseSettings(value),"Settings saved")}>Save settings</button></div></Management>}
function ReorderReports(){
  const [data,setData]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[preview,setPreview]=useState<any>(null),[email,setEmail]=useState("");
  const load=async()=>{setBusy(true);try{setData(await getWarehouseReorderAdminData());setError("")}catch(e){setError(messageOf(e))}finally{setBusy(false)}};useEffect(()=>{const timer=window.setTimeout(()=>{load()},0);return()=>window.clearTimeout(timer)},[]);
  const settings=data?.settings||{automatic_enabled:false,weekdays:[],recipients:[]};const change=(next:any)=>{setData((current:any)=>({...current,settings:{...current.settings,...next}}));setPreview(null)};
  const addEmail=()=>{const value=email.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)){setError("Enter a valid recipient email address.");return}if(!settings.recipients.includes(value))change({recipients:[...settings.recipients,value]});setEmail("");setError("")};
  const save=async()=>{setBusy(true);try{await saveWarehouseReorderSettings(settings.automatic_enabled,settings.weekdays,settings.recipients);setNotice("Reorder report settings saved.");await load()}catch(e){setError(messageOf(e));setBusy(false)}};
  const run=async(action:string,values:any={})=>{setBusy(true);setError("");try{const result=await invokeWarehouseReorderReport(action,values);if(action==="preview"){setPreview(result);setNotice(result.empty_message||"Preview generated. Nothing has been emailed yet.")}else{setPreview(null);setNotice(action==="test-connection"?result.message:`Report finished: ${result.status}.`);await load()}}catch(e){setError(messageOf(e))}finally{setBusy(false)}};
  const days=[[0,"Sunday"],[1,"Monday"],[2,"Tuesday"],[3,"Wednesday"],[4,"Thursday"],[5,"Friday"],[6,"Saturday"]] as [number,string][];const pdfUrl=preview?.pdf_base64?`data:application/pdf;base64,${preview.pdf_base64}`:"";
  return <><PageHead eyebrow="ADMINISTRATION" title="Reorder Reports" subtitle="Email a PDF of active products whose available quantity is at or below their individual threshold."/><div className="reorder-grid"><section className="panel reorder-settings"><h3>Automatic weekly report</h3><label className="toggle-row"><span><b>Enable automatic email</b><small>Runs at 2:00 PM Pacific on selected days. Disabled by default.</small></span><input type="checkbox" checked={settings.automatic_enabled} onChange={e=>change({automatic_enabled:e.target.checked})}/></label><fieldset><legend>Weekdays</legend><div className="weekday-grid">{days.map(([id,label])=><label key={id}><input type="checkbox" checked={settings.weekdays.includes(id)} onChange={e=>change({weekdays:e.target.checked?[...settings.weekdays,id]:settings.weekdays.filter((x:number)=>x!==id)})}/>{label}</label>)}</div></fieldset><label>Recipient email addresses<div className="recipient-entry"><input type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&(e.preventDefault(),addEmail())} placeholder="purchasing@example.com"/><button className="secondary" onClick={addEmail}>Add</button></div></label><div className="recipient-list">{settings.recipients.map((value:string)=><span key={value}>{value}<button aria-label={`Remove ${value}`} onClick={()=>change({recipients:settings.recipients.filter((x:string)=>x!==value)})}>×</button></span>)}{!settings.recipients.length&&<small>No recipients configured.</small>}</div><div className="button-row"><button className="primary" disabled={busy||!data} onClick={save}>{busy?"Working…":"Save settings"}</button><button className="secondary" disabled={busy} onClick={()=>run("test-connection")}>Test Gmail connection</button></div></section><section className="panel"><h3>Generate manually</h3><p>Manual reports work when automatic scheduling is off. Previewing never sends email.</p><button className="primary wide" disabled={busy||!settings.recipients.length} onClick={()=>run("preview")}>{busy?"Generating…":"Generate & Email Now"}</button>{preview&&<div className="report-preview"><h4>Confirm this exact snapshot</h4><p><b>{preview.item_count}</b> qualifying product{preview.item_count===1?"":"s"} · {new Date(preview.generated_at).toLocaleString()}</p><p>Recipients: {preview.recipients.join(", ")}</p>{preview.snapshot?.length?<div className="preview-table">{preview.snapshot.map((x:any)=><div key={x.product_id}><span><b>{x.name}</b><small>{x.category}</small></span><strong>{x.available} available</strong></div>)}</div>:<p className="empty-copy">No items need reordering. Confirmation sends a no-items message without a PDF.</p>}<div className="button-row">{pdfUrl&&<a className="secondary button-link" href={pdfUrl} download="habaneros-reorder-preview.pdf">Open PDF preview</a>}<button className="primary" disabled={busy} onClick={()=>window.confirm(`Send this report to ${preview.recipients.length} recipient(s)?`)&&run("confirm",{run_id:preview.id})}>Confirm & Send</button></div></div>}</section></div>{error&&<div className="inline-error" role="alert">{error}</div>}{notice&&<div className="security-note">{notice}</div>}<section className="panel report-history"><h3>Recent report history</h3>{data?.history?.map((x:any)=><div className="simple-row" key={x.id}><div className="grow"><b>{x.trigger_type} report · {x.item_count} items</b><small>{new Date(x.generated_at).toLocaleString()} · {x.recipients.join(", ")||"No recipients"}</small></div><span className={`status ${x.status==="sent"?"status-delivered":"status-confirmed"}`}>{x.status}</span></div>)}{data&&!data.history?.length&&<p className="empty-copy">No reorder reports have run yet.</p>}</section></>;
}
function MovementLog({movements}:{movements:Movement[]}){return <Management title="Inventory movement log" subtitle="A permanent record of every stock change."><div>{movements.map(x=><div className="simple-row" key={x.id}><div className="movement-qty">{x.quantity>0?"+":""}{x.quantity}</div><div className="grow"><b>{x.product}</b><small>{x.action} · {x.reason} · {x.actor||"System"} · {when(x.created_at)}</small></div></div>)}{!movements.length&&<p className="empty-copy">No inventory movements yet.</p>}</div></Management>}
function PageHead({eyebrow,title,subtitle,action}:{eyebrow:string;title:string;subtitle:string;action?:React.ReactNode}){return <div className="page-head"><div><small>{eyebrow}</small><h1>{title}</h1><p>{subtitle}</p></div>{action&&<div>{action}</div>}</div>}
function Stat({n,label,tone}:{n:string;label:string;tone:string}){return <div className={`stat ${tone}`}><b>{n}</b><span>{label}</span></div>}
function PanelTitle({title,action,onClick}:{title:string;action?:string;onClick?:()=>void}){return <div className="panel-title"><h3>{title}</h3>{action&&<button onClick={onClick}>{action} →</button>}</div>}
function OrderList({orders,select,queue=false,selected=[],toggle,hide}:{orders:Order[];select:(o:Order)=>void;queue?:boolean;selected?:string[];toggle?:(id:string)=>void;hide?:(id:string)=>void}){return <section className="panel order-list"><OrderRows orders={orders} select={select} queue={queue} selected={selected} toggle={toggle} hide={hide}/>{!orders.length&&<p className="empty-copy">No orders found.</p>}</section>}
function OrderRows({orders,select,queue=false,selected=[],toggle,hide}:{orders:Order[];select:(o:Order)=>void;queue?:boolean;selected?:string[];toggle?:(id:string)=>void;hide?:(id:string)=>void}){return <div className="orders">{orders.map(o=><div className={`order-row-wrap ${queue?"queue-row":""}`} key={o.id}>{queue&&<label className="order-checkbox" aria-label={`Select order ${o.order_number}`}><input type="checkbox" checked={selected.includes(o.id)} onChange={()=>toggle?.(o.id)}/></label>}<button className="order-row" onClick={()=>select(o)}><span><b>{o.order_number}</b><small>{o.location}</small></span><span><b>{o.manager}</b><small>{when(o.submitted_at)}</small></span><span>{o.items.length} items</span><span className={statusClass(o.status)}>{o.status}</span><i>→</i></button>{queue&&(o.status==="Delivered"||o.status==="Cancelled")&&<button className="queue-delete" onClick={()=>hide?.(o.id)}>Remove from queue</button>}</div>)}</div>}
function PickingList({orders,products}:{orders:Order[];products:Product[]}){const items=consolidatePickingItems(orders,products);return <section className="picking-list print-only print-area"><header className="picking-header"><div><small>WAREHOUSE FULFILLMENT</small><h1>Consolidated Picking List</h1><p>{items.length} product{items.length===1?"":"s"} across {orders.length} active order{orders.length===1?"":"s"}</p></div><div><b>Printed</b><span>{new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date())}</span></div></header>{items.length?<table className="picking-table"><thead><tr><th>Item</th><th>SKU</th><th>Category</th><th>Storage location</th><th>Orders</th><th>Total</th></tr></thead><tbody>{items.map(item=><tr key={item.key}><td><b>{item.name}</b>{item.unit_size&&<small>{item.unit_size}</small>}</td><td>{item.sku||"—"}</td><td>{item.category||"—"}</td><td>{item.item_location||"Not set"}</td><td>{item.orders.join(", ")}</td><td className="pick-total">{item.quantity}</td></tr>)}</tbody></table>:<p className="empty-picking">No active products currently need picking.</p>}<footer>Generated from Submitted, Confirmed, Picking, and Out for Delivery orders visible in the Order Queue.</footer></section>}
function ListToolbar({search,setSearch,placeholder,children}:{search:string;setSearch:(value:string)=>void;placeholder:string;children?:React.ReactNode}){return <div className="list-toolbar"><div className="search">⌕ <input aria-label={placeholder} placeholder={placeholder} value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button className="clear-search" aria-label="Clear search" onClick={()=>setSearch("")}>×</button>}</div>{children}</div>}
function Management({title,subtitle,button,onAdd,children}:{title:string;subtitle:string;button?:string;onAdd?:()=>void;children:React.ReactNode}){return <><PageHead eyebrow="ADMINISTRATION" title={title} subtitle={subtitle} action={button?<button className="primary" onClick={onAdd}>+ {button}</button>:undefined}/><section className="panel management">{children}</section></>}
function SimpleRows({rows,label,detail,edit,remove}:{rows:any[];label:(x:any)=>string;detail:(x:any)=>string;edit:(x:any)=>void;remove?:(x:any)=>void}){return <div>{rows.map(x=><div className="simple-row" key={x.id}><div className="grow"><b>{label(x)}</b><small>{detail(x)}</small></div><span className={x.is_active?"status status-delivered":"status status-cancelled"}>{x.is_active?"Active":"Inactive"}</span><div className="row-actions"><button className="secondary" onClick={()=>edit(x)}>Edit</button>{remove&&<button className="danger-button" onClick={()=>remove(x)}>Delete</button>}</div></div>)}</div>}
function Empty({text,action,onClick}:{text:string;action:string;onClick:()=>void}){return <div className="empty"><p>{text}</p><button className="secondary" onClick={onClick}>{action}</button></div>}
function navIcon(v:View){return ({catalog:"▦",cart:"▣",history:"◷",dashboard:"⌂",orders:"▤",orderHistory:"◷",products:"□",categories:"≡",locations:"⌖",adjustment:"±",movements:"↕",reorderReports:"⇩",users:"♙",settings:"⚙"} as Record<View,string>)[v]}
