/* eslint-disable @typescript-eslint/no-explicit-any, jsx-a11y/label-has-associated-control, jsx-a11y/no-autofocus, jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import {
  changeWarehouseInventory, deleteWarehouseCategory, deleteWarehouseLocation, deleteWarehouseProduct, deleteWarehouseUser,
  hideFinalizedOrdersFromQueue,
  getWarehouseData, loginWithPin, logoutWarehouse,
  restoreWarehouseSession, saveWarehouseCategory, saveWarehouseLocation,
  saveWarehouseProduct, saveWarehouseSettings, saveWarehouseUser,
  submitWarehouseOrder, updateWarehouseOrder, uploadWarehouseProductImage, removeWarehouseProductImage, productImageUrl,
} from "@/lib/supabase";

type Role = "manager" | "fulfillment" | "admin";
type View = "catalog" | "cart" | "history" | "dashboard" | "orders" | "orderHistory" | "products" | "categories" | "locations" | "adjustment" | "movements" | "users" | "settings";
type Product = {id:string;category_id:string|null;category:string|null;name:string;sku:string|null;description:string|null;unit_size:string|null;image_path:string|null;item_location:string|null;low_stock_threshold:number;is_active:boolean;is_archived:boolean;on_hand:number;reserved:number;available:number};
type Category = {id:string;name:string;is_active:boolean;sort_order:number};
type Location = {id:string;name:string;is_active:boolean;assigned?:boolean;sort_order:number};
type User = {id:string;display_name:string;role:Role;is_active:boolean;location_id:string|null};
type OrderItem = {id:string;product_id:string|null;name:string;sku:string|null;unit_size:string|null;item_location:string|null;requested_quantity:number;delivered_quantity:number;cancelled_quantity:number;fulfillment_note:string|null};
type Order = {id:string;order_number:string;manager_id:string|null;manager:string;location_id:string|null;location:string;status:string;order_note:string|null;fulfillment_note:string|null;delivery_note:string|null;submitted_at:string;delivered_at:string|null;queue_hidden?:boolean;items:OrderItem[]};
type Movement = {id:string;product_id:string;product:string;quantity:number;action:string;reason:string;actor:string|null;created_at:string};
type AppData = {user:{id:string;display_name:string;role:Role};locations:Location[];categories:Category[];products:Product[];orders:Order[];movements:Movement[];users:User[];settings:Record<string,any>};

const statusClass = (s:string) => `status status-${s.toLowerCase().replaceAll(" ","-")}`;
const messageOf = (error:unknown) => error instanceof Error ? error.message : String((error as any)?.message || error || "Something went wrong");
const when = (value:string) => new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(value));

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
  const [theme,setTheme] = useState<"light"|"dark">(()=>window.localStorage.getItem("warehouse-theme")==="dark"?"dark":"light");

  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),2800)};
  const refresh=async()=>{const next=await getWarehouseData();setData(next);setSelectedOrder(current=>current?next.orders.find((o:Order)=>o.id===current.id)||null:null);return next};
  const act=async<T,>(action:()=>Promise<T>,success?:string)=>{setWorking(true);try{const result=await action();await refresh();if(success)notify(success);return result}catch(error){notify(messageOf(error));throw error}finally{setWorking(false)}};

  useEffect(()=>{restoreWarehouseSession().then(saved=>{if(saved){setData(saved);setView(saved.user.role==="manager"?"catalog":"dashboard")}}).finally(()=>setLoading(false))},[]);
  // Refresh periodically so a second device sees warehouse changes without reloading.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{if(!data)return;const timer=window.setInterval(()=>refresh().catch(()=>undefined),30000);return()=>window.clearInterval(timer)},[data?.user.id]);

  async function login(){
    if(pin.length!==4){notify("Enter a 4-digit code");return}
    setWorking(true);
    try{await loginWithPin(pin);const next=await refresh();setPin("");setView(next.user.role==="manager"?"catalog":"dashboard");notify(`Welcome, ${next.user.display_name}`)}
    catch(error){notify(messageOf(error))}finally{setWorking(false);setLoading(false)}
  }
  async function logout(){setWorking(true);try{await logoutWarehouse()}finally{setData(null);setPin("");setCart({});setSelectedOrder(null);setView("catalog");setWorking(false)}}
  function navigate(next:View){setSelectedOrder(null);setView(next)}
  function changeQty(id:string,next:number){const product=data!.products.find(x=>x.id===id)!;setCart(current=>({...current,[id]:Math.max(0,Math.min(next,product.available))}))}
  async function submitOrder(){
    const items=Object.entries(cart).filter(([,quantity])=>quantity>0).map(([product_id,quantity])=>({product_id,quantity}));
    if(!location){notify("Choose a destination location");return}if(!items.length){notify("Add at least one product");return}
    try{await act(()=>submitWarehouseOrder(location,note,items),"Warehouse order submitted");setCart({});setNote("");setLocation("");navigate("history")}catch{return}
  }
  async function updateOrder(order:Order,status:string,fulfillmentNote:string,deliveryNote:string){
    const finalized=(value:string)=>value==="Delivered"||value==="Cancelled";
    if(status!==order.status&&(finalized(order.status)||finalized(status))&&!window.confirm(`Change this order from ${order.status} to ${status}? Inventory and reservations will be updated automatically.`))return;
    try{await act(()=>updateWarehouseOrder(order.id,status,fulfillmentNote,deliveryNote),status===order.status?"Order notes saved":`Order status changed to ${status}`)}catch{return}
  }

  const toggleTheme=()=>setTheme(current=>{const next=current==="dark"?"light":"dark";window.localStorage.setItem("warehouse-theme",next);return next});
  if(loading)return <main className="login-page" data-theme={theme}><section className="login-card loading-card"><BrandLogo/><h2>Opening warehouse...</h2></section></main>;
  if(!data)return <Login pin={pin} setPin={setPin} login={login} toast={toast} working={working} theme={theme} toggleTheme={toggleTheme}/>;

  const role=data.user.role;
  const cartCount=Object.values(cart).reduce((sum,qty)=>sum+qty,0);
  const managerNav:[View,string][]=[["catalog","Catalog"],["cart",`Cart${cartCount?` (${cartCount})`:""}`],["history","My Orders"]];
  const staffNav:[View,string][]=[["dashboard","Dashboard"],["orders","Order Queue"],["orderHistory","Order History"],["products","Products"],["categories","Categories"],["locations","Locations"],["adjustment","Adjust"],["movements","Movement Log"],...(role==="admin"?[["users","Employees & Codes"] as [View,string]]:[]),["settings","Settings"]];
  const nav=role==="manager"?managerNav:staffNav;
  return <div className={`app-shell ${working?"is-working":""}`} data-theme={theme} style={{"--print-logo":'url("./assets/habaneros-logo.png")'} as React.CSSProperties}>
    <header className="topbar"><button className="brand" onClick={()=>navigate(role==="manager"?"catalog":"dashboard")} aria-label="Habanero's Mexican Food warehouse home"><BrandLogo compact/></button><div className="account"><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme==="dark"?"light":"dark"} mode`}>{theme==="dark"?"☀ Light":"◐ Dark"}</button><span className="account-copy"><b>{data.user.display_name}</b><small>{role==="manager"?"Store Manager":role==="admin"?"Administrator":"Fulfillment"}</small></span><button className="icon-button" onClick={logout} aria-label="Sign out">↪</button></div></header>
    <div className="body"><aside>{role!=="manager"&&<div className={`role-banner role-${role}`}>{role==="admin"?"Administrator":"Fulfillment"}</div>}<nav>{nav.map(([id,label])=><button key={id} className={view===id&&!selectedOrder?"active":""} onClick={()=>navigate(id)}><span>{navIcon(id)}</span>{label}</button>)}</nav><div className="warehouse-state"><span className="pulse"/>Warehouse online</div></aside>
    <main>{role==="manager"?<Manager data={data} view={view} navigate={navigate} selectedOrder={selectedOrder} setSelectedOrder={setSelectedOrder} cart={cart} changeQty={changeQty} cartCount={cartCount} category={category} setCategory={setCategory} search={search} setSearch={setSearch} location={location} setLocation={setLocation} note={note} setNote={setNote} submitOrder={submitOrder}/>:<Admin data={data} view={view} navigate={navigate} selectedOrder={selectedOrder} setSelectedOrder={setSelectedOrder} act={act} updateOrder={updateOrder}/>}</main></div>
    {toast&&<div className={`toast ${toast.toLowerCase().includes("invalid")||toast.toLowerCase().includes("required")?"error":""}`}>{toast}</div>}
  </div>;
}

function Login({pin,setPin,login,toast,working,theme,toggleTheme}:{pin:string;setPin:(v:string)=>void;login:()=>void;toast:string;working:boolean;theme:"light"|"dark";toggleTheme:()=>void}){
  const inputRef=useRef<HTMLInputElement>(null);
  return <main className="login-page" data-theme={theme}><button className="theme-toggle login-theme" onClick={toggleTheme}>{theme==="dark"?"☀ Light mode":"◐ Dark mode"}</button><section className="login-card"><div className="login-brand"><BrandLogo/></div><p className="product-title">Warehouse Ordering</p><div className="rule"/><h2>Welcome back</h2><p>Enter your 4-digit warehouse access code.</p><label htmlFor="access-code">Access code</label><div className="pin-entry" onClick={()=>inputRef.current?.focus()}><div className="pin-boxes" aria-hidden="true">{[0,1,2,3].map(i=><span key={i}>{pin[i]?"•":""}</span>)}</div><input id="access-code" ref={inputRef} autoFocus className="pin-input" aria-label="4-digit access code" inputMode="numeric" autoComplete="one-time-code" maxLength={4} value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))} onKeyDown={e=>e.key==="Enter"&&login()}/></div><button className="primary wide" disabled={working} onClick={login}>{working?"Signing in...":"Continue"}</button><p className="help">Use the code assigned by your warehouse administrator.</p></section>{toast&&<div className="toast error">{toast}</div>}</main>
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

function ProductCard({product,qty,change}:{product:Product;qty:number;change:(id:string,q:number)=>void}){const image=productImageUrl(product.image_path);return <article className={`product-card ${product.available===0?"out":""}`}><div className="product-image">{image?<img src={image} alt=""/>:<span>□</span>}{product.available===0&&<b>OUT OF STOCK</b>}</div><div className="product-info"><div className="meta"><span>{product.category||"Uncategorized"}</span><span>{product.sku}</span></div><h3>{product.name}</h3><p>{product.description}</p><small>{product.unit_size}</small><div className="availability"><span className={product.available<=product.low_stock_threshold?"low":""}>{product.available===0?"Unavailable":`${product.available} available`}</span>{product.available>0&&<Qty value={qty} max={product.available} onChange={value=>change(product.id,value)}/>}</div></div></article>}
function Qty({value,max,onChange}:{value:number;max:number;onChange:(v:number)=>void}){return <div className="qty"><button aria-label="Decrease quantity" onClick={()=>onChange(value-1)} disabled={value===0}>−</button><span>{value}</span><button aria-label="Increase quantity" onClick={()=>onChange(value+1)} disabled={value>=max}>+</button></div>}
function SubmitPanel(p:any){return <section className="panel submit-panel"><h3>Delivery details</h3><label>Destination location <b>*</b></label><select value={p.location} onChange={(e:any)=>p.setLocation(e.target.value)}><option value="">Select a location</option>{p.data.locations.filter((x:Location)=>x.is_active).map((x:Location)=><option key={x.id} value={x.id}>{x.name}</option>)}</select><label>Order note <span>Optional</span></label><textarea value={p.note} onChange={(e:any)=>p.setNote(e.target.value)} placeholder="Delivery instructions or details for fulfillment..."/><div className="summary"><span>Total units</span><b>{p.cartCount}</b></div><button className="primary wide" onClick={p.submitOrder}>Submit Warehouse Order</button><small className="center">Submitting reserves available warehouse inventory.</small></section>}

function Admin(p:any){
  const [editor,setEditor]=useState<{kind:"product"|"category"|"location"|"user";value:any}|null>(null);
  const [queueSearch,setQueueSearch]=useState("");
  const [selectedQueueOrders,setSelectedQueueOrders]=useState<string[]>([]);
  const [historyCutoff]=useState(()=>Date.now()-30*86400000);
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
  const hideFromQueue=async(ids:string[])=>{const eligible=ids.filter(id=>p.data.orders.some((o:Order)=>o.id===id&&(o.status==="Delivered"||o.status==="Cancelled")));if(!eligible.length){window.alert("Only Delivered or Cancelled orders can be removed from the active queue.");return}const ignored=ids.length-eligible.length;const detail=ignored?` ${ignored} other selected order${ignored===1?" was":"s were"} ignored.`:"";if(!window.confirm(`Remove ${eligible.length} Delivered/Cancelled order${eligible.length===1?"":"s"} from the active queue? Order History will be preserved.${detail}`))return;try{await p.act(()=>hideFinalizedOrdersFromQueue(eligible),`${eligible.length} order${eligible.length===1?"":"s"} moved to Order History`);setSelectedQueueOrders([])}catch{return}};
  const toggleQueueOrder=(id:string)=>setSelectedQueueOrders(current=>current.includes(id)?current.filter(x=>x!==id):[...current,id]);
  if(p.selectedOrder)return <OrderDetail order={p.selectedOrder} back={()=>p.setSelectedOrder(null)} update={(status:string,fulfillment:string,delivery:string)=>p.updateOrder(p.selectedOrder,status,fulfillment,delivery)}/>;
  const open=(kind:any,value:any={})=>setEditor({kind,value});
  let content:React.ReactNode;
  if(p.view==="dashboard")content=<Dashboard data={p.data} navigate={p.navigate} select={p.setSelectedOrder}/>;
  else if(p.view==="orders"){const orders=p.data.orders.filter((o:Order)=>!o.queue_hidden&&(o.status!=="Delivered"||!o.delivered_at||new Date(o.delivered_at).getTime()>=historyCutoff)).filter((o:Order)=>`${o.order_number} ${o.manager} ${o.location} ${o.status}`.toLowerCase().includes(queueSearch.toLowerCase()));content=<><PageHead eyebrow="FULFILLMENT" title="Order queue" subtitle="Delivered orders remain here for 30 days. Delivered or Cancelled orders can be moved to history sooner." action={<button className="secondary" onClick={()=>window.print()}>Print picking list</button>}/><div className="filters"><div className="search">⌕ <input placeholder="Search order, location, manager..." value={queueSearch} onChange={e=>setQueueSearch(e.target.value)}/></div></div>{selectedQueueOrders.length>0&&<div className="bulk-bar"><span><b>{selectedQueueOrders.length}</b> selected</span><button className="danger-button" onClick={()=>hideFromQueue(selectedQueueOrders)}>Remove selected Delivered/Cancelled orders from queue</button><button className="secondary" onClick={()=>setSelectedQueueOrders([])}>Clear</button></div>}<OrderList orders={orders} select={p.setSelectedOrder} queue selected={selectedQueueOrders} toggle={toggleQueueOrder} hide={id=>hideFromQueue([id])}/></>}
  else if(p.view==="orderHistory"){const orders=p.data.orders.filter((o:Order)=>(o.status==="Delivered"&&(o.queue_hidden||!!o.delivered_at&&new Date(o.delivered_at).getTime()<historyCutoff))||(o.status==="Cancelled"&&o.queue_hidden)).filter((o:Order)=>`${o.order_number} ${o.manager} ${o.location} ${o.status}`.toLowerCase().includes(queueSearch.toLowerCase()));content=<><PageHead eyebrow="FULFILLMENT" title="Order history" subtitle="Delivered orders moved manually or after 30 days, plus Cancelled orders removed from the queue."/><div className="filters"><div className="search">⌕ <input placeholder="Search order, location, manager..." value={queueSearch} onChange={e=>setQueueSearch(e.target.value)}/></div></div><OrderList orders={orders} select={p.setSelectedOrder}/></>}
  else if(p.view==="products")content=<Management title="Product management" subtitle="Add, edit, and permanently delete warehouse products." button="Add product" onAdd={()=>open("product")}><div className="responsive-table product-table"><div className="table-head"><span>Product</span><span>Category</span><span>Item location</span><span>On hand</span><span>Reserved</span><span>Available</span><span></span></div>{p.data.products.map((x:Product)=><div className="table-row" key={x.id}><span data-label="Product" className="product-list-name">{x.image_path?<img src={productImageUrl(x.image_path)} alt=""/>:<span className="product-thumb-placeholder">□</span>}<span><b>{x.name}</b><small>{x.sku} · {x.unit_size}</small></span></span><span data-label="Category">{x.category||"Uncategorized"}</span><span data-label="Item location">{x.item_location||"—"}</span><span data-label="On hand">{x.on_hand}</span><span data-label="Reserved">{x.reserved}</span><span data-label="Available"><b className={x.available<=x.low_stock_threshold?"danger-text":""}>{x.available}</b></span><span className="row-actions"><button className="secondary" onClick={()=>open("product",x)}>Edit</button>{p.data.user.role==="admin"&&<button className="danger-button" onClick={()=>remove("product",x)}>Delete</button>}</span></div>)}</div></Management>;
  else if(p.view==="categories")content=<Management title="Categories" subtitle="Keep the manager catalog organized." button="Add category" onAdd={()=>open("category")}><SimpleRows rows={p.data.categories} label={(x:any)=>x.name} detail={(x:any)=>`${p.data.products.filter((product:Product)=>product.category_id===x.id).length} products`} edit={(x:any)=>open("category",x)} remove={p.data.user.role==="admin"?(x:any)=>remove("category",x):undefined}/></Management>;
  else if(p.view==="locations")content=<Management title="Locations" subtitle="Manage manager destinations." button="Add location" onAdd={()=>open("location")}><SimpleRows rows={p.data.locations} label={(x:any)=>x.name} detail={(x:any)=>`${p.data.orders.filter((order:Order)=>order.location_id===x.id).length} orders`} edit={(x:any)=>open("location",x)} remove={p.data.user.role==="admin"?(x:any)=>remove("location",x):undefined}/></Management>;
  else if(p.view==="adjustment")content=<InventoryForm data={p.data} act={p.act}/>;
  else if(p.view==="movements")content=<MovementLog movements={p.data.movements}/>;
  else if(p.view==="users")content=<Management title="Employees & access codes" subtitle="Add, reset, or permanently delete employee access." button="Add employee" onAdd={()=>open("user")}><SimpleRows rows={p.data.users} label={(x:any)=>x.display_name} detail={(x:any)=>`${x.role} · ${p.data.locations.find((l:Location)=>l.id===x.location_id)?.name||"Warehouse"}`} edit={(x:any)=>open("user",x)} remove={(x:any)=>remove("user",x)}/><div className="security-note">PINs are one-way hashed. Leave the PIN blank when editing to keep the current code. Historical orders retain the saved manager name after an employee is deleted.</div></Management>;
  else content=<Settings data={p.data} act={p.act}/>;
  return <>{content}{editor&&<EditorModal editor={editor} categories={p.data.categories} locations={p.data.locations} close={()=>setEditor(null)} save={save}/>}</>;
}

function Dashboard({data,navigate,select}:{data:AppData;navigate:(v:View)=>void;select:(o:Order)=>void}){
  const count=(status:string)=>data.orders.filter(o=>o.status===status).length;
  return <><PageHead eyebrow="FULFILLMENT OVERVIEW" title={`Good morning, ${data.user.display_name}`} subtitle="Here is what needs attention at the warehouse." action={<button className="primary" onClick={()=>navigate("orders")}>Open order queue →</button>}/><div className="stats"><Stat n={String(data.orders.filter(o=>!["Delivered","Cancelled"].includes(o.status)).length)} label="Pending orders" tone="orange"/><Stat n={String(count("Picking"))} label="Currently picking" tone="blue"/><Stat n={String(count("Out for Delivery"))} label="Out for delivery" tone="purple"/><Stat n={String(data.products.filter(x=>x.available<=x.low_stock_threshold).length)} label="Low-stock alerts" tone="red"/></div><div className="dashboard-grid"><section className="panel wide-panel"><PanelTitle title="Recently submitted" action="View queue" onClick={()=>navigate("orders")}/><OrderRows orders={data.orders.slice(0,4)} select={select}/></section><section className="panel"><PanelTitle title="Low stock" action="Manage" onClick={()=>navigate("products")}/>{data.products.filter(x=>x.available<=x.low_stock_threshold).slice(0,5).map(x=><div className="stock-row" key={x.id}><div className="product-icon small">□</div><div className="grow"><b>{x.name}</b><small>{x.sku}</small></div><strong>{x.available}</strong></div>)}</section><section className="panel"><PanelTitle title="Recent adjustments" action="Movement log" onClick={()=>navigate("movements")}/>{data.movements.slice(0,3).map(x=><div className="audit-row" key={x.id}><span>{x.quantity>0?"+":""}{x.quantity}</span><div><b>{x.product}</b><small>{x.reason}</small></div></div>)}</section></div></>;
}

function OrderDetail({order,back,manager,update}:{order:Order;back:()=>void;manager?:boolean;update?:(s:string,f:string,d:string)=>void}){
  const [fulfillment,setFulfillment]=useState(order.fulfillment_note||"");
  const [delivery,setDelivery]=useState(order.delivery_note||"");
  return <div className="print-area"><button className="back no-print" onClick={back}>← Back to orders</button><PageHead eyebrow={order.order_number} title={`${order.location} order`} subtitle={`Submitted by ${order.manager} · ${when(order.submitted_at)}`} action={<span className={statusClass(order.status)}>{order.status}</span>}/><div className="split"><section className="panel"><h3>Picking & packing details</h3>{order.items.map((x,i)=><div className="pick-row" key={x.id}><span className="pick-num">{i+1}</span><div className="grow"><b>{x.name}</b><small>{x.sku} · {x.unit_size}</small>{!manager&&<span className="item-location">Item Location: {x.item_location||"Not set"}</span>}</div><strong>{x.requested_quantity} requested</strong></div>)}{!manager&&<div className="screen-notes"><label>Fulfillment notes<textarea value={fulfillment} onChange={e=>setFulfillment(e.target.value)} placeholder="Substitutions, shortages, or packing notes..."/></label><label>Delivery note<textarea value={delivery} onChange={e=>setDelivery(e.target.value)} placeholder="Where and to whom the order was delivered..."/></label></div>}<div className="print-only print-notes"><h3>Order notes</h3><div><b>Manager note</b><p>{order.order_note||"None"}</p></div><div><b>Fulfillment note</b><p>{fulfillment||"None"}</p></div><div><b>Delivery note</b><p>{delivery||"None"}</p></div></div></section><section className="panel order-side"><h3>Order details</h3><dl><div><dt>Destination</dt><dd>{order.location}</dd></div><div><dt>Manager</dt><dd>{order.manager}</dd></div><div><dt>Items</dt><dd>{order.items.length}</dd></div><div><dt>Order note</dt><dd>{order.order_note||"None"}</dd></div></dl>{!manager&&<><label>Update status</label><div className="status-actions">{["Confirmed","Picking","Out for Delivery","Delivered","Cancelled"].map(status=><button key={status} className={order.status===status?"primary":"secondary"} onClick={()=>update?.(status,fulfillment,delivery)}>{status}</button>)}</div><button className="secondary wide" onClick={()=>update?.(order.status,fulfillment,delivery)}>Save notes</button><button className="print-button" onClick={()=>window.print()}>Print picking list</button></>}</section></div></div>;
}

function InventoryForm({data,act}:{data:AppData;act:any}){
  const [productId,setProductId]=useState("");const [quantity,setQuantity]=useState("");const [reason,setReason]=useState("");
  const product=data.products.find(x=>x.id===productId);
  async function submit(){const amount=Number(quantity);if(!productId||!amount||!reason.trim())return;try{await act(()=>changeWarehouseInventory(productId,amount,"adjusted",reason),"Inventory adjustment recorded");setQuantity("");setReason("")}catch{return}}
  return <><PageHead eyebrow="INVENTORY" title="Adjust inventory" subtitle="Correct warehouse stock with a required audit reason."/><section className="panel form-panel"><label>Product<select value={productId} onChange={e=>setProductId(e.target.value)}><option value="">Select a product</option>{data.products.map(x=><option key={x.id} value={x.id}>{x.name} · {x.sku}</option>)}</select></label>{product&&<div className="inventory-preview"><span>On hand <b>{product.on_hand}</b></span><span>Reserved <b>{product.reserved}</b></span><span>Available <b>{product.available}</b></span></div>}<div className="form-grid"><label>Quantity change<input type="number" value={quantity} onChange={e=>setQuantity(e.target.value)} placeholder="e.g. -2 or 5"/></label><label>Adjustment reason<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="Required reason"/></label></div><button className="primary" disabled={!productId||!Number(quantity)||!reason.trim()} onClick={submit}>Record adjustment</button></section></>;
}

function EditorModal({editor,categories,locations,close,save}:{editor:any;categories:Category[];locations:Location[];close:()=>void;save:(kind:string,value:any)=>Promise<void>}){
  const defaults:any={product:{name:"",sku:"",category_id:categories[0]?.id||null,description:"",unit_size:"",item_location:"",image_path:null,low_stock_threshold:8},category:{name:"",is_active:true},location:{name:"",is_active:true},user:{display_name:"",role:"manager",pin:"",location_id:locations[0]?.id||null,is_active:true}};
  const [value,setValue]=useState({...defaults[editor.kind],...editor.value,pin:""});
  const [saving,setSaving]=useState(false);
  const [formError,setFormError]=useState("");
  const set=(key:string,next:any)=>{setFormError("");setValue((current:any)=>({...current,[key]:next}))};
  const submit=async()=>{
    setFormError("");
    const name=(value.name||value.display_name||"").trim();
    if(!name){setFormError(`${editor.kind==="user"?"Display name":`${editor.kind[0].toUpperCase()+editor.kind.slice(1)} name`} is required.`);return}
    if(editor.kind==="user"&&!editor.value.id&&value.pin.length!==4){setFormError("Enter a 4-digit access code.");return}
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
        <label>Low-stock threshold<input type="number" min="0" value={value.low_stock_threshold} onChange={e=>set("low_stock_threshold",e.target.value)}/></label>
        <ProductImageUpload currentPath={value.image_path} file={value._imageFile} disabled={saving} onFile={file=>set("_imageFile",file)} onError={error=>set("_imageError",error)}/>
        {value._imageError&&<div className="field-error" role="alert">{value._imageError}</div>}
      </>}
      {(editor.kind==="category"||editor.kind==="location")&&<label>Name<input autoFocus value={value.name} onChange={e=>set("name",e.target.value)}/></label>}
      {editor.kind==="user"&&<><label>Display name<input value={value.display_name} onChange={e=>set("display_name",e.target.value)}/></label><div className="form-grid"><label>Role<select value={value.role} onChange={e=>set("role",e.target.value)}><option value="manager">Manager</option><option value="fulfillment">Fulfillment</option><option value="admin">Administrator</option></select></label><label>{editor.value.id?"New 4-digit code (optional)":"4-digit code"}<input inputMode="numeric" maxLength={4} value={value.pin} onChange={e=>set("pin",e.target.value.replace(/\D/g,"").slice(0,4))}/></label></div>{value.role==="manager"&&<label>Location<select value={value.location_id||""} onChange={e=>set("location_id",e.target.value)}>{locations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}</>}
      {editor.kind==="category"&&<label className="check-row"><input type="checkbox" checked={value.is_active} onChange={e=>set("is_active",e.target.checked)}/> Active</label>}
    </div>
    {formError&&<div className="form-error" role="alert">{formError}</div>}
    <div className="modal-actions"><button className="secondary" disabled={saving} onClick={close}>Cancel</button><button className="primary" disabled={saving} onClick={submit}>{saving?(value._imageFile?"Uploading & saving…":"Saving…"):"Save"}</button></div>
  </section></div>;
}

function ProductImageUpload({currentPath,file,disabled,onFile,onError}:{currentPath?:string|null;file?:File;disabled?:boolean;onFile:(file:File)=>void;onError:(error:string)=>void}){
  const preview=file?URL.createObjectURL(file):productImageUrl(currentPath);
  const accept=(files:FileList|null)=>{const next=files?.[0];if(!next)return;const supported=["image/jpeg","image/png","image/webp","image/gif"];if(!supported.includes(next.type)){onError("Use a JPG, PNG, WebP, or GIF image.");return}if(next.size>6*1024*1024){onError("Image must be 6 MB or smaller.");return}onError("");onFile(next)};
  return <div className={`image-upload ${disabled?"disabled":""}`} onDragOver={e=>{e.preventDefault();if(!disabled)e.currentTarget.classList.add("dragging")}} onDragLeave={e=>e.currentTarget.classList.remove("dragging")} onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");if(!disabled)accept(e.dataTransfer.files)}}>
    {preview?<img src={preview} alt="Product preview"/>:<span className="image-upload-icon">▧</span>}
    <div><b>Product picture</b><p>Drag and drop a JPG, PNG, WebP, or GIF (up to 6 MB), or browse your camera roll/files.</p>{file&&<small className="selected-file">Selected: {file.name}</small>}<label className="secondary file-button">Choose image<input type="file" disabled={disabled} accept="image/jpeg,image/png,image/webp,image/gif" onChange={e=>accept(e.target.files)}/></label></div>
  </div>;
}

function Settings({data,act}:{data:AppData;act:any}){const [value,setValue]=useState({warehouse_name:data.settings.warehouse_name||"Habaneros Central Warehouse",default_low_stock:data.settings.default_low_stock??8,show_images:data.settings.show_images??true});const set=(key:string,next:any)=>setValue(current=>({...current,[key]:next}));return <Management title="Warehouse settings" subtitle="Configure ordering and stock alerts."><div className="settings-form"><label>Warehouse display name<input value={value.warehouse_name} onChange={e=>set("warehouse_name",e.target.value)}/></label><label>Default low-stock threshold<input type="number" min="0" value={value.default_low_stock} onChange={e=>set("default_low_stock",e.target.value)}/></label><label className="toggle-row"><span><b>Show product images</b><small>Display stored product images in the catalog</small></span><input type="checkbox" checked={value.show_images} onChange={e=>set("show_images",e.target.checked)}/></label><button className="primary" onClick={()=>act(()=>saveWarehouseSettings(value),"Settings saved")}>Save settings</button></div></Management>}
function MovementLog({movements}:{movements:Movement[]}){return <Management title="Inventory movement log" subtitle="A permanent record of every stock change."><div>{movements.map(x=><div className="simple-row" key={x.id}><div className="movement-qty">{x.quantity>0?"+":""}{x.quantity}</div><div className="grow"><b>{x.product}</b><small>{x.action} · {x.reason} · {x.actor||"System"} · {when(x.created_at)}</small></div></div>)}{!movements.length&&<p className="empty-copy">No inventory movements yet.</p>}</div></Management>}
function PageHead({eyebrow,title,subtitle,action}:{eyebrow:string;title:string;subtitle:string;action?:React.ReactNode}){return <div className="page-head"><div><small>{eyebrow}</small><h1>{title}</h1><p>{subtitle}</p></div>{action&&<div>{action}</div>}</div>}
function Stat({n,label,tone}:{n:string;label:string;tone:string}){return <div className={`stat ${tone}`}><b>{n}</b><span>{label}</span></div>}
function PanelTitle({title,action,onClick}:{title:string;action?:string;onClick?:()=>void}){return <div className="panel-title"><h3>{title}</h3>{action&&<button onClick={onClick}>{action} →</button>}</div>}
function OrderList({orders,select,queue=false,selected=[],toggle,hide}:{orders:Order[];select:(o:Order)=>void;queue?:boolean;selected?:string[];toggle?:(id:string)=>void;hide?:(id:string)=>void}){return <section className="panel order-list"><OrderRows orders={orders} select={select} queue={queue} selected={selected} toggle={toggle} hide={hide}/>{!orders.length&&<p className="empty-copy">No orders found.</p>}</section>}
function OrderRows({orders,select,queue=false,selected=[],toggle,hide}:{orders:Order[];select:(o:Order)=>void;queue?:boolean;selected?:string[];toggle?:(id:string)=>void;hide?:(id:string)=>void}){return <div className="orders">{orders.map(o=><div className={`order-row-wrap ${queue?"queue-row":""}`} key={o.id}>{queue&&<label className="order-checkbox" aria-label={`Select order ${o.order_number}`}><input type="checkbox" checked={selected.includes(o.id)} onChange={()=>toggle?.(o.id)}/></label>}<button className="order-row" onClick={()=>select(o)}><span><b>{o.order_number}</b><small>{o.location}</small></span><span><b>{o.manager}</b><small>{when(o.submitted_at)}</small></span><span>{o.items.length} items</span><span className={statusClass(o.status)}>{o.status}</span><i>→</i></button>{queue&&(o.status==="Delivered"||o.status==="Cancelled")&&<button className="queue-delete" onClick={()=>hide?.(o.id)}>Remove from queue</button>}</div>)}</div>}
function Management({title,subtitle,button,onAdd,children}:{title:string;subtitle:string;button?:string;onAdd?:()=>void;children:React.ReactNode}){return <><PageHead eyebrow="ADMINISTRATION" title={title} subtitle={subtitle} action={button?<button className="primary" onClick={onAdd}>+ {button}</button>:undefined}/><section className="panel management">{children}</section></>}
function SimpleRows({rows,label,detail,edit,remove}:{rows:any[];label:(x:any)=>string;detail:(x:any)=>string;edit:(x:any)=>void;remove?:(x:any)=>void}){return <div>{rows.map(x=><div className="simple-row" key={x.id}><div className="grow"><b>{label(x)}</b><small>{detail(x)}</small></div><span className={x.is_active?"status status-delivered":"status status-cancelled"}>{x.is_active?"Active":"Inactive"}</span><div className="row-actions"><button className="secondary" onClick={()=>edit(x)}>Edit</button>{remove&&<button className="danger-button" onClick={()=>remove(x)}>Delete</button>}</div></div>)}</div>}
function Empty({text,action,onClick}:{text:string;action:string;onClick:()=>void}){return <div className="empty"><p>{text}</p><button className="secondary" onClick={onClick}>{action}</button></div>}
function navIcon(v:View){return ({catalog:"▦",cart:"▣",history:"◷",dashboard:"⌂",orders:"▤",orderHistory:"◷",products:"□",categories:"≡",locations:"⌖",adjustment:"±",movements:"↕",users:"♙",settings:"⚙"} as Record<View,string>)[v]}
