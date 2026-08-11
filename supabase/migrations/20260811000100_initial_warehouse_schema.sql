begin;

create extension if not exists pgcrypto;
create schema if not exists private;

do $$ begin
  create type public.app_role as enum ('manager','fulfillment','admin');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.order_status as enum ('Submitted','Confirmed','Picking','Out for Delivery','Delivered','Cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.inventory_movement_action as enum ('received','adjusted','reserved','delivered','cancelled','shortage');
exception when duplicate_object then null; end $$;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  role public.app_role not null,
  access_code_hash text not null,
  is_active boolean not null default true,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.manager_locations (
  manager_id uuid not null references public.app_users(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (manager_id, location_id)
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id),
  name text not null,
  sku text unique,
  description text,
  unit_size text,
  image_path text,
  low_stock_threshold integer not null default 0 check (low_stock_threshold >= 0),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.warehouse_inventory (
  product_id uuid primary key references public.products(id) on delete restrict,
  on_hand integer not null default 0 check (on_hand >= 0),
  reserved integer not null default 0 check (reserved >= 0 and reserved <= on_hand),
  available integer generated always as (on_hand - reserved) stored,
  updated_at timestamptz not null default now()
);

create sequence if not exists public.warehouse_order_number_seq start 1001;
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default ('WHO-' || lpad(nextval('public.warehouse_order_number_seq')::text, 6, '0')),
  manager_id uuid not null references public.app_users(id),
  location_id uuid not null references public.locations(id),
  status public.order_status not null default 'Submitted',
  order_note text,
  fulfillment_note text,
  cancellation_reason text,
  delivered_at timestamptz,
  delivered_by uuid references public.app_users(id),
  delivery_note text,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  product_id uuid not null references public.products(id),
  requested_quantity integer not null check (requested_quantity > 0),
  delivered_quantity integer not null default 0 check (delivered_quantity >= 0),
  cancelled_quantity integer not null default 0 check (cancelled_quantity >= 0),
  substitution_product_id uuid references public.products(id),
  substitution_note text,
  shortage_note text,
  fulfillment_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, product_id)
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  quantity integer not null check (quantity <> 0),
  action public.inventory_movement_action not null,
  actor_id uuid references public.app_users(id),
  reason text not null,
  related_order_id uuid references public.orders(id),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.app_users(id),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.app_users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_user_sessions (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists private.pin_login_attempts (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  locked_until timestamptz
);

create index if not exists app_user_sessions_user_idx on public.app_user_sessions(app_user_id);
create unique index if not exists locations_name_unique_idx on public.locations(name);
create unique index if not exists categories_name_unique_idx on public.categories(name);
create unique index if not exists products_sku_unique_idx on public.products(sku);
create index if not exists orders_manager_idx on public.orders(manager_id, submitted_at desc);
create index if not exists orders_status_idx on public.orders(status, submitted_at desc);
create index if not exists order_items_order_idx on public.order_items(order_id);
create index if not exists movements_created_idx on public.inventory_movements(created_at desc);

create or replace function private.current_app_user_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.app_user_id
  from public.app_user_sessions s
  join public.app_users u on u.id = s.app_user_id
  where s.auth_user_id = (select auth.uid()) and u.is_active
  limit 1
$$;

create or replace function private.current_app_role()
returns public.app_role language sql stable security definer set search_path = '' as $$
  select u.role from public.app_users u where u.id = private.current_app_user_id()
$$;

create or replace function public.warehouse_login_with_pin(input_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  auth_id uuid := (select auth.uid());
  matched public.app_users;
  attempt private.pin_login_attempts;
begin
  if auth_id is null then raise exception 'Authentication session required'; end if;
  if input_pin !~ '^\d{4}$' then raise exception 'Enter a 4-digit code'; end if;

  select * into attempt from private.pin_login_attempts where auth_user_id = auth_id for update;
  if attempt.locked_until is not null and attempt.locked_until > now() then
    raise exception 'Too many attempts. Try again later.';
  end if;
  if attempt.window_started_at is null or attempt.window_started_at < now() - interval '15 minutes' then
    insert into private.pin_login_attempts(auth_user_id, window_started_at, attempts, locked_until)
    values(auth_id, now(), 0, null)
    on conflict(auth_user_id) do update set window_started_at=now(), attempts=0, locked_until=null;
  end if;

  select * into matched from public.app_users
  where is_active and access_code_hash = extensions.crypt(input_pin, access_code_hash)
  order by created_at limit 1;

  if matched.id is null then
    insert into private.pin_login_attempts(auth_user_id, attempts)
    values(auth_id, 1)
    on conflict(auth_user_id) do update set
      attempts = private.pin_login_attempts.attempts + 1,
      locked_until = case when private.pin_login_attempts.attempts + 1 >= 8 then now() + interval '15 minutes' else null end;
    perform pg_sleep(0.4);
    raise exception 'Invalid access code';
  end if;

  delete from private.pin_login_attempts where auth_user_id = auth_id;
  insert into public.app_user_sessions(auth_user_id, app_user_id, last_seen_at)
  values(auth_id, matched.id, now())
  on conflict(auth_user_id) do update set app_user_id=excluded.app_user_id, last_seen_at=now();
  update public.app_users set last_login_at=now(), failed_login_count=0, locked_until=null where id=matched.id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action) values(matched.id,'app_user',matched.id,'login');
  return jsonb_build_object('id',matched.id,'display_name',matched.display_name,'role',matched.role);
end $$;

create or replace function public.warehouse_logout()
returns void language sql security definer set search_path = '' as $$
  delete from public.app_user_sessions where auth_user_id=(select auth.uid())
$$;

create or replace function public.warehouse_get_app_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.current_app_user_id(); actor_role public.app_role := private.current_app_role();
begin
  if actor is null then raise exception 'Access code required'; end if;
  update public.app_user_sessions set last_seen_at=now() where auth_user_id=(select auth.uid());
  return jsonb_build_object(
    'user',(select jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role) from public.app_users u where u.id=actor),
    'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'sort_order',l.sort_order,'is_active',l.is_active,'assigned',exists(select 1 from public.manager_locations ml where ml.manager_id=actor and ml.location_id=l.id)) order by l.sort_order,l.name) from public.locations l where actor_role<>'manager' or (l.is_active and exists(select 1 from public.manager_locations ml where ml.manager_id=actor and ml.location_id=l.id))),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name) from public.categories c where actor_role<>'manager' or c.is_active),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'category_id',p.category_id,'category',c.name,'name',p.name,'sku',p.sku,'description',p.description,'unit_size',p.unit_size,'low_stock_threshold',p.low_stock_threshold,'is_active',p.is_active,'is_archived',p.is_archived,'on_hand',coalesce(i.on_hand,0),'reserved',coalesce(i.reserved,0),'available',coalesce(i.available,0)) order by p.sort_order,p.name) from public.products p left join public.categories c on c.id=p.category_id left join public.warehouse_inventory i on i.product_id=p.id where actor_role<>'manager' or (p.is_active and not p.is_archived)),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'order_number',o.order_number,'manager_id',o.manager_id,'manager',u.display_name,'location_id',o.location_id,'location',l.name,'status',o.status,'order_note',o.order_note,'fulfillment_note',o.fulfillment_note,'delivery_note',o.delivery_note,'submitted_at',o.submitted_at,'items',coalesce((select jsonb_agg(jsonb_build_object('id',oi.id,'product_id',oi.product_id,'name',p.name,'sku',p.sku,'unit_size',p.unit_size,'requested_quantity',oi.requested_quantity,'delivered_quantity',oi.delivered_quantity,'cancelled_quantity',oi.cancelled_quantity,'fulfillment_note',oi.fulfillment_note) order by p.name) from public.order_items oi join public.products p on p.id=oi.product_id where oi.order_id=o.id),'[]'::jsonb)) order by o.submitted_at desc) from public.orders o join public.app_users u on u.id=o.manager_id join public.locations l on l.id=o.location_id where actor_role<>'manager' or o.manager_id=actor),'[]'::jsonb),
    'movements',case when actor_role='manager' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'product_id',m.product_id,'product',p.name,'quantity',m.quantity,'action',m.action,'reason',m.reason,'actor',u.display_name,'created_at',m.created_at) order by m.created_at desc) from (select * from public.inventory_movements order by created_at desc limit 200) m join public.products p on p.id=m.product_id left join public.app_users u on u.id=m.actor_id),'[]'::jsonb) end,
    'users',case when actor_role<>'admin' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role,'is_active',u.is_active,'location_id',(select ml.location_id from public.manager_locations ml where ml.manager_id=u.id limit 1)) order by u.display_name) from public.app_users u),'[]'::jsonb) end,
    'settings',coalesce((select jsonb_object_agg(s.key,s.value) from public.app_settings s),'{}'::jsonb)
  );
end $$;

create or replace function public.warehouse_submit_order(input_location_id uuid,input_note text,input_items jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); oid uuid; item jsonb; pid uuid; qty int; inv public.warehouse_inventory;
begin
  if private.current_app_role()<>'manager' then raise exception 'Manager access required'; end if;
  if not exists(select 1 from public.manager_locations where manager_id=actor and location_id=input_location_id) then raise exception 'Invalid manager location'; end if;
  if jsonb_array_length(input_items)=0 then raise exception 'Order requires items'; end if;
  insert into public.orders(manager_id,location_id,order_note) values(actor,input_location_id,nullif(trim(input_note),'')) returning id into oid;
  for item in select * from jsonb_array_elements(input_items) loop
    pid:=(item->>'product_id')::uuid; qty:=(item->>'quantity')::int;
    if qty<=0 then raise exception 'Invalid quantity'; end if;
    select * into inv from public.warehouse_inventory where product_id=pid for update;
    if not found or inv.available<qty then raise exception 'Insufficient inventory for a requested product'; end if;
    insert into public.order_items(order_id,product_id,requested_quantity) values(oid,pid,qty);
    update public.warehouse_inventory set reserved=reserved+qty,updated_at=now() where product_id=pid;
    insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id) values(pid,-qty,'reserved',actor,'Manager order submitted',oid);
  end loop;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data) values(actor,'order',oid,'submit',input_items);
  return oid;
end $$;

create or replace function public.warehouse_update_order(input_order_id uuid,input_status public.order_status,input_fulfillment_note text default null,input_delivery_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); old_status public.order_status; item record; inv public.warehouse_inventory;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  select status into old_status from public.orders where id=input_order_id for update;
  if old_status is null then raise exception 'Order not found'; end if;
  if old_status in ('Delivered','Cancelled') and input_status<>old_status then raise exception 'Finalized orders cannot change status'; end if;
  if old_status not in ('Delivered','Cancelled') and input_status='Delivered' then
    for item in select * from public.order_items where order_id=input_order_id for update loop
      update public.warehouse_inventory set on_hand=on_hand-item.requested_quantity,reserved=reserved-item.requested_quantity,updated_at=now() where product_id=item.product_id and reserved>=item.requested_quantity returning * into inv;
      if not found then raise exception 'Inventory reservation mismatch'; end if;
      update public.order_items set delivered_quantity=requested_quantity,updated_at=now() where id=item.id;
      insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id) values(item.product_id,-item.requested_quantity,'delivered',actor,'Order delivered',input_order_id);
    end loop;
  elsif old_status not in ('Delivered','Cancelled') and input_status='Cancelled' then
    for item in select * from public.order_items where order_id=input_order_id for update loop
      update public.warehouse_inventory set reserved=reserved-item.requested_quantity,updated_at=now() where product_id=item.product_id and reserved>=item.requested_quantity;
      update public.order_items set cancelled_quantity=requested_quantity,updated_at=now() where id=item.id;
      insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id) values(item.product_id,item.requested_quantity,'cancelled',actor,'Order cancelled',input_order_id);
    end loop;
  end if;
  update public.orders set status=input_status,fulfillment_note=nullif(trim(input_fulfillment_note),''),delivery_note=nullif(trim(input_delivery_note),''),delivered_at=case when input_status='Delivered' then coalesce(delivered_at,now()) else delivered_at end,delivered_by=case when input_status='Delivered' then coalesce(delivered_by,actor) else delivered_by end,updated_at=now() where id=input_order_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data,new_data) values(actor,'order',input_order_id,'update',jsonb_build_object('status',old_status),jsonb_build_object('status',input_status));
end $$;

create or replace function public.warehouse_change_inventory(input_product_id uuid,input_quantity integer,input_action public.inventory_movement_action,input_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); inv public.warehouse_inventory;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  if input_action not in ('received','adjusted') or input_quantity=0 or trim(coalesce(input_reason,''))='' then raise exception 'Quantity and reason are required'; end if;
  insert into public.warehouse_inventory(product_id,on_hand) values(input_product_id,greatest(input_quantity,0))
  on conflict(product_id) do update set on_hand=public.warehouse_inventory.on_hand+input_quantity,updated_at=now() returning * into inv;
  if inv.on_hand<inv.reserved then raise exception 'Adjustment would reduce stock below reserved inventory'; end if;
  insert into public.inventory_movements(product_id,quantity,action,actor_id,reason) values(input_product_id,input_quantity,input_action,actor,input_reason);
end $$;

create or replace function public.warehouse_save_product(input_id uuid,input_category_id uuid,input_name text,input_sku text,input_description text,input_unit_size text,input_low_stock_threshold integer,input_is_active boolean,input_is_archived boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); saved uuid;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  if trim(coalesce(input_name,''))='' then raise exception 'Product name is required'; end if;
  if input_id is null then
    insert into public.products(category_id,name,sku,description,unit_size,low_stock_threshold,is_active,is_archived)
    values(input_category_id,trim(input_name),nullif(trim(input_sku),''),nullif(trim(input_description),''),nullif(trim(input_unit_size),''),greatest(input_low_stock_threshold,0),input_is_active,input_is_archived) returning id into saved;
    insert into public.warehouse_inventory(product_id) values(saved);
  else
    update public.products set category_id=input_category_id,name=trim(input_name),sku=nullif(trim(input_sku),''),description=nullif(trim(input_description),''),unit_size=nullif(trim(input_unit_size),''),low_stock_threshold=greatest(input_low_stock_threshold,0),is_active=input_is_active,is_archived=input_is_archived,updated_at=now() where id=input_id returning id into saved;
  end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action) values(actor,'product',saved,case when input_id is null then 'create' else 'update' end);
  return saved;
end $$;

create or replace function public.warehouse_save_category(input_id uuid,input_name text,input_is_active boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); saved uuid;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  if trim(coalesce(input_name,''))='' then raise exception 'Category name is required'; end if;
  if input_id is null then insert into public.categories(name,is_active) values(trim(input_name),input_is_active) returning id into saved;
  else update public.categories set name=trim(input_name),is_active=input_is_active,updated_at=now() where id=input_id returning id into saved; end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action) values(actor,'category',saved,case when input_id is null then 'create' else 'update' end);
  return saved;
end $$;

create or replace function public.warehouse_save_location(input_id uuid,input_name text,input_is_active boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); saved uuid;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  if trim(coalesce(input_name,''))='' then raise exception 'Location name is required'; end if;
  if input_id is null then insert into public.locations(name,is_active) values(trim(input_name),input_is_active) returning id into saved;
  else update public.locations set name=trim(input_name),is_active=input_is_active,updated_at=now() where id=input_id returning id into saved; end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action) values(actor,'location',saved,case when input_id is null then 'create' else 'update' end);
  return saved;
end $$;

create or replace function public.warehouse_save_user(input_id uuid,input_display_name text,input_role public.app_role,input_pin text,input_location_id uuid,input_is_active boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); saved uuid; existing_hash text;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  if trim(coalesce(input_display_name,''))='' then raise exception 'Display name is required'; end if;
  if input_role='manager' and input_location_id is null then raise exception 'Managers require a location'; end if;
  if input_pin is not null and input_pin !~ '^\d{4}$' then raise exception 'PIN must contain exactly 4 digits'; end if;
  if input_pin is not null and exists(select 1 from public.app_users u where u.id is distinct from input_id and u.access_code_hash=extensions.crypt(input_pin,u.access_code_hash)) then raise exception 'That access code is already in use'; end if;
  if input_id is null then
    if input_pin is null then raise exception 'A PIN is required for new users'; end if;
    insert into public.app_users(display_name,role,access_code_hash,is_active,created_by) values(trim(input_display_name),input_role,extensions.crypt(input_pin,extensions.gen_salt('bf',12)),input_is_active,actor) returning id into saved;
  else
    select access_code_hash into existing_hash from public.app_users where id=input_id;
    update public.app_users set display_name=trim(input_display_name),role=input_role,access_code_hash=case when input_pin is null then existing_hash else extensions.crypt(input_pin,extensions.gen_salt('bf',12)) end,is_active=input_is_active,updated_at=now() where id=input_id returning id into saved;
  end if;
  delete from public.manager_locations where manager_id=saved;
  if input_role='manager' then insert into public.manager_locations(manager_id,location_id) values(saved,input_location_id); end if;
  if not input_is_active then delete from public.app_user_sessions where app_user_id=saved; end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action) values(actor,'app_user',saved,case when input_id is null then 'create' else 'update' end);
  return saved;
end $$;

create or replace function public.warehouse_save_settings(input_name text,input_low_stock integer,input_show_images boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id();
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  insert into public.app_settings(key,value,updated_by) values
    ('warehouse_name',to_jsonb(input_name),actor),('default_low_stock',to_jsonb(greatest(input_low_stock,0)),actor),('show_images',to_jsonb(input_show_images),actor)
  on conflict(key) do update set value=excluded.value,updated_by=actor,updated_at=now();
end $$;

alter table public.app_users enable row level security;
alter table public.locations enable row level security;
alter table public.manager_locations enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.warehouse_inventory enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.audit_logs enable row level security;
alter table public.app_settings enable row level security;
alter table public.app_user_sessions enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function public.warehouse_login_with_pin(text),public.warehouse_logout(),public.warehouse_get_app_data(),public.warehouse_submit_order(uuid,text,jsonb),public.warehouse_update_order(uuid,public.order_status,text,text),public.warehouse_change_inventory(uuid,integer,public.inventory_movement_action,text),public.warehouse_save_product(uuid,uuid,text,text,text,text,integer,boolean,boolean),public.warehouse_save_category(uuid,text,boolean),public.warehouse_save_location(uuid,text,boolean),public.warehouse_save_user(uuid,text,public.app_role,text,uuid,boolean),public.warehouse_save_settings(text,integer,boolean) to authenticated;

insert into public.locations(name,sort_order) values ('Riverside',1),('Downtown',2),('Northside',3) on conflict(name) do nothing;
insert into public.categories(name,sort_order) values ('Packaging',1),('Supplies',2),('Pantry',3) on conflict(name) do nothing;

with rows(name,sku,category,description,unit_size,low_stock,on_hand) as (values
  ('Compostable Bowl Lids','PKG-1042','Packaging','Clear fitted lids for 32 oz bowls','Case / 300',8,18),
  ('Large Paper Bags','PKG-2110','Packaging','Reinforced handled takeout bags','Bundle / 250',6,7),
  ('Nitrile Gloves - L','SUP-3008','Supplies','Powder-free black nitrile gloves','Case / 10 boxes',10,24),
  ('Foil Burrito Sheets','PKG-1009','Packaging','Pre-cut foodservice foil sheets','Case / 3,000',5,0),
  ('Jalapeno Hot Sauce','PAN-4012','Pantry','House-label hot sauce bottles','Case / 24',12,31),
  ('Receipt Paper','SUP-2024','Supplies','Thermal register rolls','Case / 50',6,14)
), inserted as (
  insert into public.products(name,sku,category_id,description,unit_size,low_stock_threshold)
  select r.name,r.sku,c.id,r.description,r.unit_size,r.low_stock from rows r join public.categories c on c.name=r.category
  on conflict(sku) do update set name=excluded.name,category_id=excluded.category_id,description=excluded.description,unit_size=excluded.unit_size,low_stock_threshold=excluded.low_stock_threshold
  returning id,sku
)
insert into public.warehouse_inventory(product_id,on_hand)
select p.id,r.on_hand from rows r join public.products p on p.sku=r.sku
on conflict(product_id) do nothing;

insert into public.warehouse_inventory(product_id,on_hand)
select p.id, case p.sku
  when 'PKG-1042' then 18 when 'PKG-2110' then 7 when 'SUP-3008' then 24
  when 'PKG-1009' then 0 when 'PAN-4012' then 31 when 'SUP-2024' then 14 else 0 end
from public.products p
on conflict(product_id) do nothing;

insert into public.app_users(display_name,role,access_code_hash,is_active)
select 'Test Manager','manager',extensions.crypt('1234',extensions.gen_salt('bf',12)),true
where not exists(select 1 from public.app_users where display_name='Test Manager');
update public.app_users set access_code_hash=extensions.crypt('1234',extensions.gen_salt('bf',12)),role='manager',is_active=true where display_name='Test Manager';
insert into public.manager_locations(manager_id,location_id)
select u.id,l.id from public.app_users u cross join public.locations l where u.display_name='Test Manager' and l.name='Riverside'
on conflict do nothing;

insert into public.app_users(display_name,role,access_code_hash,is_active)
select 'Warehouse Fulfillment','fulfillment',extensions.crypt('5678',extensions.gen_salt('bf',12)),true
where not exists(select 1 from public.app_users where display_name='Warehouse Fulfillment');
update public.app_users set access_code_hash=extensions.crypt('5678',extensions.gen_salt('bf',12)),role='fulfillment',is_active=true where display_name='Warehouse Fulfillment';
update public.app_users set access_code_hash=extensions.crypt('9876',extensions.gen_salt('bf',12)),role='admin',is_active=true where display_name='Isaac';

insert into public.app_settings(key,value) values
  ('warehouse_name','"Habaneros Central Warehouse"'::jsonb),('default_low_stock','8'::jsonb),('show_images','true'::jsonb)
on conflict(key) do nothing;

commit;
