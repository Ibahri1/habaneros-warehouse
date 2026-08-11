begin;
create extension if not exists pgcrypto;
create schema if not exists private;
create schema if not exists api;

create type public.app_role as enum ('manager','fulfillment','admin');
create type public.order_status as enum ('Submitted','Confirmed','Picking','Out for Delivery','Delivered','Cancelled');
create type public.order_item_status as enum ('Requested','Fulfilled','Substituted','Shortage','Cancelled');
create type public.inventory_movement_type as enum ('received','adjusted','reserved','delivered','cancelled','shortage');

create table public.roles (id public.app_role primary key, description text not null);
insert into public.roles values ('manager','Store manager'),('fulfillment','Warehouse fulfillment'),('admin','Warehouse administrator');
create table public.locations (id uuid primary key default gen_random_uuid(),name text not null unique,address text,active boolean not null default true,sort_order integer not null default 0,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.app_users (id uuid primary key default gen_random_uuid(),auth_user_id uuid unique references auth.users(id) on delete set null,display_name text not null,role public.app_role not null references public.roles(id),location_id uuid references public.locations(id),pin_hash text not null,active boolean not null default true,last_login_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),constraint managers_require_location check (role <> 'manager' or location_id is not null));
create table public.categories (id uuid primary key default gen_random_uuid(),name text not null unique,description text,active boolean not null default true,sort_order integer not null default 0,created_at timestamptz not null default now());
create table public.products (id uuid primary key default gen_random_uuid(),category_id uuid not null references public.categories(id),sku text not null unique,name text not null,description text,unit_size text not null,image_path text,low_stock_threshold integer not null default 0 check(low_stock_threshold>=0),archived_at timestamptz,sort_order integer not null default 0,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.warehouse_inventory (product_id uuid primary key references public.products(id),on_hand integer not null default 0 check(on_hand>=0),reserved integer not null default 0 check(reserved>=0 and reserved<=on_hand),available integer generated always as (on_hand-reserved) stored,updated_at timestamptz not null default now());
create table public.orders (id uuid primary key default gen_random_uuid(),order_number bigint generated always as identity unique,manager_id uuid not null references public.app_users(id),location_id uuid not null references public.locations(id),status public.order_status not null default 'Submitted',order_note text,fulfillment_note text,delivery_note text,submitted_at timestamptz not null default now(),confirmed_at timestamptz,picking_at timestamptz,out_for_delivery_at timestamptz,delivered_at timestamptz,cancelled_at timestamptz,updated_at timestamptz not null default now());
create table public.order_items (id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete restrict,product_id uuid not null references public.products(id),requested_quantity integer not null check(requested_quantity>0),fulfilled_quantity integer check(fulfilled_quantity>=0),status public.order_item_status not null default 'Requested',substitute_product_id uuid references public.products(id),shortage_quantity integer not null default 0 check(shortage_quantity>=0),item_note text,unique(order_id,product_id));
create table public.inventory_movements (id bigint generated always as identity primary key,product_id uuid not null references public.products(id),movement_type public.inventory_movement_type not null,quantity integer not null check(quantity<>0),on_hand_after integer not null,reserved_after integer not null,order_id uuid references public.orders(id),order_item_id uuid references public.order_items(id),reason text not null,performed_by uuid references public.app_users(id),created_at timestamptz not null default now());
create table public.audit_logs (id bigint generated always as identity primary key,actor_id uuid references public.app_users(id),action text not null,entity_type text not null,entity_id text,details jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());
create table public.app_settings (key text primary key,value jsonb not null,updated_by uuid references public.app_users(id),updated_at timestamptz not null default now());

create index app_users_auth_idx on public.app_users(auth_user_id); create index orders_manager_idx on public.orders(manager_id,submitted_at desc); create index orders_location_idx on public.orders(location_id,submitted_at desc); create index orders_status_idx on public.orders(status,submitted_at); create index order_items_order_idx on public.order_items(order_id); create index inventory_movements_product_idx on public.inventory_movements(product_id,created_at desc);

create function private.current_app_user_id() returns uuid language sql stable security definer set search_path='' as $$ select id from public.app_users where auth_user_id=(select auth.uid()) and active limit 1 $$;
create function private.current_app_role() returns public.app_role language sql stable security definer set search_path='' as $$ select role from public.app_users where auth_user_id=(select auth.uid()) and active limit 1 $$;
revoke all on function private.current_app_user_id() from public; revoke all on function private.current_app_role() from public; grant execute on function private.current_app_user_id(),private.current_app_role() to authenticated;

create function api.login_with_pin(input_pin text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.app_users;
begin
 if (select auth.uid()) is null then raise exception 'Authentication session required'; end if;
 if input_pin !~ '^\d{4}$' then raise exception 'Invalid code'; end if;
 select * into u from public.app_users where active and pin_hash=crypt(input_pin,pin_hash) limit 1;
 if u.id is null then perform pg_sleep(.35); raise exception 'Invalid code'; end if;
 if u.auth_user_id is not null and u.auth_user_id<>(select auth.uid()) then raise exception 'Code is already active on another device; ask an administrator to reset the session'; end if;
 update public.app_users set auth_user_id=(select auth.uid()),last_login_at=now() where id=u.id;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(u.id,'login','app_user',u.id::text);
 return jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role,'location_id',u.location_id);
end $$;

create function api.submit_warehouse_order(input_location_id uuid,input_note text,input_items jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); oid uuid; item jsonb; pid uuid; qty int; inv public.warehouse_inventory;
begin
 if private.current_app_role()<>'manager' then raise exception 'Manager access required'; end if;
 if not exists(select 1 from public.locations where id=input_location_id and active) then raise exception 'Invalid location'; end if;
 if jsonb_array_length(input_items)=0 then raise exception 'Order requires items'; end if;
 insert into public.orders(manager_id,location_id,order_note) values(actor,input_location_id,nullif(trim(input_note),'')) returning id into oid;
 for item in select * from jsonb_array_elements(input_items) loop
  pid:=(item->>'product_id')::uuid; qty:=(item->>'quantity')::int;
  if qty<=0 then raise exception 'Invalid quantity'; end if;
  select * into inv from public.warehouse_inventory where product_id=pid for update;
  if not found or inv.available<qty or exists(select 1 from public.products where id=pid and archived_at is not null) then raise exception 'Insufficient available inventory'; end if;
  insert into public.order_items(order_id,product_id,requested_quantity) values(oid,pid,qty);
  update public.warehouse_inventory set reserved=reserved+qty,updated_at=now() where product_id=pid returning * into inv;
  insert into public.inventory_movements(product_id,movement_type,quantity,on_hand_after,reserved_after,order_id,reason,performed_by) values(pid,'reserved',-qty,inv.on_hand,inv.reserved,oid,'Manager order submitted',actor);
 end loop;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(actor,'submit','order',oid::text); return oid;
end $$;

create function api.set_order_status(input_order_id uuid,input_status public.order_status,input_fulfillment_note text default null,input_delivery_note text default null) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); old_status public.order_status; i record; inv public.warehouse_inventory; release_qty int;
begin
 if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
 select status into old_status from public.orders where id=input_order_id for update; if old_status is null then raise exception 'Order not found'; end if;
 if old_status in ('Delivered','Cancelled') then raise exception 'Finalized orders cannot be changed'; end if;
 if input_status='Delivered' then
  for i in select * from public.order_items where order_id=input_order_id for update loop
   release_qty:=case when i.status in ('Cancelled','Shortage') then greatest(i.requested_quantity-i.shortage_quantity,0) else coalesce(i.fulfilled_quantity,i.requested_quantity) end;
   update public.warehouse_inventory set on_hand=on_hand-release_qty,reserved=reserved-release_qty,updated_at=now() where product_id=i.product_id and reserved>=release_qty returning * into inv;
   if not found then raise exception 'Inventory invariant failed'; end if;
   insert into public.inventory_movements(product_id,movement_type,quantity,on_hand_after,reserved_after,order_id,order_item_id,reason,performed_by) values(i.product_id,'delivered',-release_qty,inv.on_hand,inv.reserved,input_order_id,i.id,'Order delivered',actor);
  end loop;
 elsif input_status='Cancelled' then
  for i in select * from public.order_items where order_id=input_order_id for update loop
   update public.warehouse_inventory set reserved=reserved-i.requested_quantity,updated_at=now() where product_id=i.product_id returning * into inv;
   insert into public.inventory_movements(product_id,movement_type,quantity,on_hand_after,reserved_after,order_id,order_item_id,reason,performed_by) values(i.product_id,'cancelled',i.requested_quantity,inv.on_hand,inv.reserved,input_order_id,i.id,'Order cancelled',actor);
   update public.order_items set status='Cancelled' where id=i.id;
  end loop;
 end if;
 update public.orders set status=input_status,fulfillment_note=coalesce(input_fulfillment_note,fulfillment_note),delivery_note=case when input_status='Delivered' then nullif(trim(input_delivery_note),'') else delivery_note end,confirmed_at=case when input_status='Confirmed' then now() else confirmed_at end,picking_at=case when input_status='Picking' then now() else picking_at end,out_for_delivery_at=case when input_status='Out for Delivery' then now() else out_for_delivery_at end,delivered_at=case when input_status='Delivered' then now() else delivered_at end,cancelled_at=case when input_status='Cancelled' then now() else cancelled_at end,updated_at=now() where id=input_order_id;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(actor,'status_change','order',input_order_id::text,jsonb_build_object('from',old_status,'to',input_status));
end $$;

create function api.change_inventory(input_product_id uuid,input_quantity integer,input_type public.inventory_movement_type,input_reason text) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); inv public.warehouse_inventory;
begin
 if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
 if input_type not in ('received','adjusted') or input_quantity=0 or trim(coalesce(input_reason,''))='' then raise exception 'Quantity and reason are required'; end if;
 insert into public.warehouse_inventory(product_id,on_hand) values(input_product_id,greatest(input_quantity,0)) on conflict(product_id) do update set on_hand=public.warehouse_inventory.on_hand+input_quantity,updated_at=now() returning * into inv;
 if inv.on_hand<inv.reserved then raise exception 'Adjustment would reduce on hand below reserved'; end if;
 insert into public.inventory_movements(product_id,movement_type,quantity,on_hand_after,reserved_after,reason,performed_by) values(input_product_id,input_type,input_quantity,inv.on_hand,inv.reserved,input_reason,actor);
end $$;

alter table public.roles enable row level security; alter table public.locations enable row level security; alter table public.app_users enable row level security; alter table public.categories enable row level security; alter table public.products enable row level security; alter table public.warehouse_inventory enable row level security; alter table public.orders enable row level security; alter table public.order_items enable row level security; alter table public.inventory_movements enable row level security; alter table public.audit_logs enable row level security; alter table public.app_settings enable row level security;
create policy locations_read on public.locations for select to authenticated using(private.current_app_user_id() is not null);
create policy categories_read on public.categories for select to authenticated using(private.current_app_user_id() is not null);
create policy products_read on public.products for select to authenticated using(private.current_app_user_id() is not null);
create policy inventory_read on public.warehouse_inventory for select to authenticated using(private.current_app_user_id() is not null);
create policy own_user_read on public.app_users for select to authenticated using(id=private.current_app_user_id() or private.current_app_role() in ('fulfillment','admin'));
create policy staff_manage_users on public.app_users for all to authenticated using(private.current_app_role()='admin') with check(private.current_app_role()='admin');
create policy staff_manage_locations on public.locations for all to authenticated using(private.current_app_role() in ('fulfillment','admin')) with check(private.current_app_role() in ('fulfillment','admin'));
create policy staff_manage_categories on public.categories for all to authenticated using(private.current_app_role() in ('fulfillment','admin')) with check(private.current_app_role() in ('fulfillment','admin'));
create policy staff_manage_products on public.products for all to authenticated using(private.current_app_role() in ('fulfillment','admin')) with check(private.current_app_role() in ('fulfillment','admin'));
create policy orders_read on public.orders for select to authenticated using(manager_id=private.current_app_user_id() or private.current_app_role() in ('fulfillment','admin'));
create policy order_items_read on public.order_items for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and (o.manager_id=private.current_app_user_id() or private.current_app_role() in ('fulfillment','admin'))));
create policy movements_staff_read on public.inventory_movements for select to authenticated using(private.current_app_role() in ('fulfillment','admin'));
create policy audit_staff_read on public.audit_logs for select to authenticated using(private.current_app_role()='admin');
create policy settings_staff on public.app_settings for all to authenticated using(private.current_app_role() in ('fulfillment','admin')) with check(private.current_app_role() in ('fulfillment','admin'));

grant usage on schema api to authenticated; grant execute on function api.login_with_pin(text),api.submit_warehouse_order(uuid,text,jsonb),api.set_order_status(uuid,public.order_status,text,text),api.change_inventory(uuid,integer,public.inventory_movement_type,text) to authenticated;
grant select on public.locations,public.categories,public.products,public.warehouse_inventory,public.orders,public.order_items,public.inventory_movements,public.audit_logs,public.app_settings to authenticated;
grant select,insert,update,delete on public.app_users,public.locations,public.categories,public.products,public.app_settings to authenticated;
revoke all on all functions in schema api from public; grant usage on schema api to authenticated; grant execute on all functions in schema api to authenticated;
commit;
