begin;

alter table public.products add column if not exists item_location text;
alter table public.orders add column if not exists manager_name_snapshot text;
alter table public.orders add column if not exists location_name_snapshot text;
alter table public.order_items add column if not exists product_name_snapshot text;
alter table public.order_items add column if not exists sku_snapshot text;
alter table public.order_items add column if not exists unit_size_snapshot text;
alter table public.order_items add column if not exists item_location_snapshot text;
alter table public.inventory_movements add column if not exists product_name_snapshot text;

update public.orders o set manager_name_snapshot=coalesce(o.manager_name_snapshot,u.display_name) from public.app_users u where u.id=o.manager_id;
update public.orders o set location_name_snapshot=coalesce(o.location_name_snapshot,l.name) from public.locations l where l.id=o.location_id;
update public.order_items oi set product_name_snapshot=coalesce(oi.product_name_snapshot,p.name),sku_snapshot=coalesce(oi.sku_snapshot,p.sku),unit_size_snapshot=coalesce(oi.unit_size_snapshot,p.unit_size),item_location_snapshot=coalesce(oi.item_location_snapshot,p.item_location) from public.products p where p.id=oi.product_id;
update public.inventory_movements m set product_name_snapshot=coalesce(m.product_name_snapshot,p.name) from public.products p where p.id=m.product_id;

alter table public.orders alter column manager_name_snapshot set not null;
alter table public.orders alter column location_name_snapshot set not null;
alter table public.order_items alter column product_name_snapshot set not null;
alter table public.inventory_movements alter column product_name_snapshot set not null;

alter table public.orders drop constraint if exists orders_manager_id_fkey;
alter table public.orders drop constraint if exists orders_location_id_fkey;
alter table public.orders drop constraint if exists orders_delivered_by_fkey;
alter table public.orders alter column manager_id drop not null;
alter table public.orders alter column location_id drop not null;
alter table public.orders add constraint orders_manager_id_fkey foreign key(manager_id) references public.app_users(id) on delete set null;
alter table public.orders add constraint orders_location_id_fkey foreign key(location_id) references public.locations(id) on delete set null;
alter table public.orders add constraint orders_delivered_by_fkey foreign key(delivered_by) references public.app_users(id) on delete set null;

alter table public.order_items drop constraint if exists order_items_product_id_fkey;
alter table public.order_items drop constraint if exists order_items_substitution_product_id_fkey;
alter table public.order_items alter column product_id drop not null;
alter table public.order_items add constraint order_items_product_id_fkey foreign key(product_id) references public.products(id) on delete set null;
alter table public.order_items add constraint order_items_substitution_product_id_fkey foreign key(substitution_product_id) references public.products(id) on delete set null;
alter table public.inventory_movements drop constraint if exists inventory_movements_product_id_fkey;
alter table public.inventory_movements alter column product_id drop not null;
alter table public.inventory_movements add constraint inventory_movements_product_id_fkey foreign key(product_id) references public.products(id) on delete set null;
alter table public.warehouse_inventory drop constraint if exists warehouse_inventory_product_id_fkey;
alter table public.warehouse_inventory add constraint warehouse_inventory_product_id_fkey foreign key(product_id) references public.products(id) on delete cascade;

alter table public.app_users drop constraint if exists app_users_created_by_fkey;
alter table public.app_users add constraint app_users_created_by_fkey foreign key(created_by) references public.app_users(id) on delete set null;
alter table public.inventory_movements drop constraint if exists inventory_movements_actor_id_fkey;
alter table public.inventory_movements add constraint inventory_movements_actor_id_fkey foreign key(actor_id) references public.app_users(id) on delete set null;
alter table public.audit_logs drop constraint if exists audit_logs_actor_id_fkey;
alter table public.audit_logs add constraint audit_logs_actor_id_fkey foreign key(actor_id) references public.app_users(id) on delete set null;
alter table public.app_settings drop constraint if exists app_settings_updated_by_fkey;
alter table public.app_settings add constraint app_settings_updated_by_fkey foreign key(updated_by) references public.app_users(id) on delete set null;

create or replace function private.snapshot_inventory_movement_product()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.product_name_snapshot is null and new.product_id is not null then select name into new.product_name_snapshot from public.products where id=new.product_id; end if;
  return new;
end $$;
drop trigger if exists inventory_movement_product_snapshot on public.inventory_movements;
create trigger inventory_movement_product_snapshot before insert on public.inventory_movements for each row execute function private.snapshot_inventory_movement_product();

drop function if exists public.warehouse_save_product(uuid,uuid,text,text,text,text,integer,boolean,boolean);
create function public.warehouse_save_product(input_id uuid,input_category_id uuid,input_name text,input_sku text,input_description text,input_unit_size text,input_low_stock_threshold integer,input_image_path text,input_item_location text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); saved uuid;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  if trim(coalesce(input_name,''))='' then raise exception 'Product name is required'; end if;
  if input_id is null then
    insert into public.products(category_id,name,sku,description,unit_size,low_stock_threshold,image_path,item_location,is_active,is_archived)
    values(input_category_id,trim(input_name),nullif(trim(input_sku),''),nullif(trim(input_description),''),nullif(trim(input_unit_size),''),greatest(input_low_stock_threshold,0),nullif(trim(input_image_path),''),nullif(trim(input_item_location),''),true,false) returning id into saved;
    insert into public.warehouse_inventory(product_id) values(saved);
  else
    update public.products set category_id=input_category_id,name=trim(input_name),sku=nullif(trim(input_sku),''),description=nullif(trim(input_description),''),unit_size=nullif(trim(input_unit_size),''),low_stock_threshold=greatest(input_low_stock_threshold,0),image_path=nullif(trim(input_image_path),''),item_location=nullif(trim(input_item_location),''),is_active=true,is_archived=false,updated_at=now() where id=input_id returning id into saved;
  end if;
  if saved is null then raise exception 'Product not found'; end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action) values(actor,'product',saved,case when input_id is null then 'create' else 'update' end);
  return saved;
end $$;

create or replace function public.warehouse_submit_order(input_location_id uuid,input_note text,input_items jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); oid uuid; row_data jsonb; pid uuid; qty integer; inventory record; manager_name text; location_name text;
begin
  if private.current_app_role()<>'manager' then raise exception 'Manager access required'; end if;
  if not exists(select 1 from public.manager_locations where manager_id=actor and location_id=input_location_id) then raise exception 'Invalid manager location'; end if;
  select display_name into manager_name from public.app_users where id=actor;
  select name into location_name from public.locations where id=input_location_id;
  if location_name is null then raise exception 'Location not found'; end if;
  insert into public.orders(manager_id,location_id,manager_name_snapshot,location_name_snapshot,order_note) values(actor,input_location_id,manager_name,location_name,nullif(trim(input_note),'')) returning id into oid;
  for row_data in select * from jsonb_array_elements(input_items) loop
    pid=(row_data->>'product_id')::uuid; qty=(row_data->>'quantity')::integer;
    if qty<=0 then raise exception 'Invalid quantity'; end if;
    select i.on_hand,i.reserved,i.available into inventory from public.warehouse_inventory i join public.products p on p.id=i.product_id where i.product_id=pid and p.is_active and not p.is_archived for update of i;
    if not found or inventory.available<qty then raise exception 'Insufficient available inventory'; end if;
    insert into public.order_items(order_id,product_id,product_name_snapshot,sku_snapshot,unit_size_snapshot,item_location_snapshot,requested_quantity)
    select oid,p.id,p.name,p.sku,p.unit_size,p.item_location,qty from public.products p where p.id=pid;
    update public.warehouse_inventory set reserved=reserved+qty,updated_at=now() where product_id=pid;
    insert into public.inventory_movements(product_id,product_name_snapshot,quantity,action,actor_id,reason,related_order_id) select p.id,p.name,-qty,'reserved',actor,'Order submitted',oid from public.products p where p.id=pid;
  end loop;
  return oid;
end $$;

create or replace function public.warehouse_get_app_data()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); actor_role public.app_role:=private.current_app_role();
begin
  if actor is null then raise exception 'Warehouse session required'; end if;
  return jsonb_build_object(
    'user',(select jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role) from public.app_users u where u.id=actor),
    'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'sort_order',l.sort_order,'is_active',l.is_active,'assigned',exists(select 1 from public.manager_locations ml where ml.manager_id=actor and ml.location_id=l.id)) order by l.sort_order,l.name) from public.locations l where actor_role<>'manager' or exists(select 1 from public.manager_locations ml where ml.manager_id=actor and ml.location_id=l.id)),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort_order',c.sort_order,'is_active',c.is_active) order by c.sort_order,c.name) from public.categories c),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'category_id',p.category_id,'category',c.name,'name',p.name,'sku',p.sku,'description',p.description,'unit_size',p.unit_size,'image_path',p.image_path,'item_location',p.item_location,'low_stock_threshold',p.low_stock_threshold,'is_active',p.is_active,'is_archived',p.is_archived,'on_hand',coalesce(i.on_hand,0),'reserved',coalesce(i.reserved,0),'available',coalesce(i.available,0)) order by p.sort_order,p.name) from public.products p left join public.categories c on c.id=p.category_id left join public.warehouse_inventory i on i.product_id=p.id where actor_role<>'manager' or (p.is_active and not p.is_archived)),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'order_number',o.order_number,'manager_id',o.manager_id,'manager',o.manager_name_snapshot,'location_id',o.location_id,'location',o.location_name_snapshot,'status',o.status,'order_note',o.order_note,'fulfillment_note',o.fulfillment_note,'delivery_note',o.delivery_note,'submitted_at',o.submitted_at,'delivered_at',o.delivered_at,'items',coalesce((select jsonb_agg(jsonb_build_object('id',oi.id,'product_id',oi.product_id,'name',oi.product_name_snapshot,'sku',oi.sku_snapshot,'unit_size',oi.unit_size_snapshot,'item_location',oi.item_location_snapshot,'requested_quantity',oi.requested_quantity,'delivered_quantity',oi.delivered_quantity,'cancelled_quantity',oi.cancelled_quantity,'fulfillment_note',oi.fulfillment_note) order by oi.product_name_snapshot) from public.order_items oi where oi.order_id=o.id),'[]'::jsonb)) order by o.submitted_at desc) from public.orders o where actor_role<>'manager' or o.manager_id=actor),'[]'::jsonb),
    'movements',case when actor_role='manager' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'product_id',m.product_id,'product',m.product_name_snapshot,'quantity',m.quantity,'action',m.action,'reason',m.reason,'actor',u.display_name,'created_at',m.created_at) order by m.created_at desc) from (select * from public.inventory_movements order by created_at desc limit 200) m left join public.app_users u on u.id=m.actor_id),'[]'::jsonb) end,
    'users',case when actor_role<>'admin' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role,'is_active',u.is_active,'location_id',(select ml.location_id from public.manager_locations ml where ml.manager_id=u.id limit 1)) order by u.display_name) from public.app_users u),'[]'::jsonb) end,
    'settings',coalesce((select jsonb_object_agg(s.key,s.value) from public.app_settings s),'{}'::jsonb)
  );
end $$;

drop function if exists public.warehouse_delete_product(uuid);
create function public.warehouse_delete_product(input_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); old_row public.products; reserved_qty integer;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  select * into old_row from public.products where id=input_id for update;
  if old_row.id is null then raise exception 'Product not found'; end if;
  select coalesce(reserved,0) into reserved_qty from public.warehouse_inventory where product_id=input_id;
  if reserved_qty>0 then raise exception 'Cancel or deliver active orders reserving this product before deletion'; end if;
  delete from public.products where id=input_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data) values(actor,'product',input_id,'delete',to_jsonb(old_row));
  return old_row.image_path;
end $$;

create or replace function public.warehouse_delete_location(input_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); old_row public.locations;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  select * into old_row from public.locations where id=input_id for update;
  if old_row.id is null then raise exception 'Location not found'; end if;
  delete from public.locations where id=input_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data) values(actor,'location',input_id,'delete',to_jsonb(old_row));
end $$;

create or replace function public.warehouse_delete_user(input_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); old_row public.app_users;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  if input_id=actor then raise exception 'You cannot delete your own signed-in account'; end if;
  select * into old_row from public.app_users where id=input_id for update;
  if old_row.id is null then raise exception 'Employee not found'; end if;
  delete from public.app_users where id=input_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data) values(actor,'user',input_id,'delete',jsonb_build_object('display_name',old_row.display_name,'role',old_row.role));
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('product-images','product-images',true,6291456,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists "warehouse admins upload product images" on storage.objects;
drop policy if exists "warehouse admins update product images" on storage.objects;
drop policy if exists "warehouse admins delete product images" on storage.objects;
create policy "warehouse admins upload product images" on storage.objects for insert to authenticated with check(bucket_id='product-images' and private.current_app_role() in ('fulfillment','admin'));
create policy "warehouse admins update product images" on storage.objects for update to authenticated using(bucket_id='product-images' and private.current_app_role() in ('fulfillment','admin')) with check(bucket_id='product-images' and private.current_app_role() in ('fulfillment','admin'));
create policy "warehouse admins delete product images" on storage.objects for delete to authenticated using(bucket_id='product-images' and private.current_app_role()='admin');

revoke all on function public.warehouse_save_product(uuid,uuid,text,text,text,text,integer,text,text),public.warehouse_delete_product(uuid),public.warehouse_delete_location(uuid),public.warehouse_delete_user(uuid) from public,anon,authenticated;
grant execute on function public.warehouse_save_product(uuid,uuid,text,text,text,text,integer,text,text),public.warehouse_delete_product(uuid),public.warehouse_delete_location(uuid),public.warehouse_delete_user(uuid) to authenticated;
grant select,insert,update,delete on storage.objects to authenticated;

commit;
