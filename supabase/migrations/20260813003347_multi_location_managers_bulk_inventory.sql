begin;

alter table public.app_users add column if not exists all_locations boolean not null default false;

create or replace function public.warehouse_get_app_data()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); actor_role public.app_role:=private.current_app_role();
begin
  if actor is null then raise exception 'Warehouse session required'; end if;
  return jsonb_build_object(
    'user',(select jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role) from public.app_users u where u.id=actor),
    'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'sort_order',l.sort_order,'is_active',l.is_active,'assigned',case when actor_role='manager' then (select u.all_locations from public.app_users u where u.id=actor) or exists(select 1 from public.manager_locations ml where ml.manager_id=actor and ml.location_id=l.id) else true end) order by l.sort_order,l.name) from public.locations l where actor_role<>'manager' or (l.is_active and ((select u.all_locations from public.app_users u where u.id=actor) or exists(select 1 from public.manager_locations ml where ml.manager_id=actor and ml.location_id=l.id)))),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort_order',c.sort_order,'is_active',c.is_active) order by c.sort_order,c.name) from public.categories c),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'category_id',p.category_id,'category',c.name,'name',p.name,'sku',p.sku,'description',p.description,'unit_size',p.unit_size,'image_path',p.image_path,'item_location',p.item_location,'low_stock_threshold',p.low_stock_threshold,'is_active',p.is_active,'is_archived',p.is_archived,'on_hand',coalesce(i.on_hand,0),'reserved',coalesce(i.reserved,0),'available',coalesce(i.available,0)) order by p.sort_order,p.name) from public.products p left join public.categories c on c.id=p.category_id left join public.warehouse_inventory i on i.product_id=p.id where actor_role<>'manager' or (p.is_active and not p.is_archived)),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'order_number',o.order_number,'manager_id',o.manager_id,'manager',o.manager_name_snapshot,'location_id',o.location_id,'location',o.location_name_snapshot,'status',o.status,'order_note',o.order_note,'fulfillment_note',o.fulfillment_note,'delivery_note',o.delivery_note,'submitted_at',o.submitted_at,'delivered_at',o.delivered_at,'items',coalesce((select jsonb_agg(jsonb_build_object('id',oi.id,'product_id',oi.product_id,'name',oi.product_name_snapshot,'sku',oi.sku_snapshot,'unit_size',oi.unit_size_snapshot,'item_location',oi.item_location_snapshot,'requested_quantity',oi.requested_quantity,'delivered_quantity',oi.delivered_quantity,'cancelled_quantity',oi.cancelled_quantity,'fulfillment_note',oi.fulfillment_note) order by oi.product_name_snapshot) from public.order_items oi where oi.order_id=o.id),'[]'::jsonb)) order by o.submitted_at desc) from public.orders o where actor_role<>'manager' or o.manager_id=actor),'[]'::jsonb),
    'movements',case when actor_role='manager' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'product_id',m.product_id,'product',m.product_name_snapshot,'quantity',m.quantity,'action',m.action,'reason',m.reason,'actor',u.display_name,'created_at',m.created_at) order by m.created_at desc) from (select * from public.inventory_movements order by created_at desc limit 200) m left join public.app_users u on u.id=m.actor_id),'[]'::jsonb) end,
    'users',case when actor_role<>'admin' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'role',u.role,'is_active',u.is_active,'all_locations',u.all_locations,'location_ids',coalesce((select jsonb_agg(ml.location_id order by l.sort_order,l.name) from public.manager_locations ml join public.locations l on l.id=ml.location_id where ml.manager_id=u.id),'[]'::jsonb)) order by u.display_name) from public.app_users u),'[]'::jsonb) end,
    'settings',coalesce((select jsonb_object_agg(s.key,s.value) from public.app_settings s),'{}'::jsonb)
  );
end $$;

create or replace function public.warehouse_submit_order(input_location_id uuid,input_note text,input_items jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); oid uuid; item jsonb; pid uuid; qty int; inventory public.warehouse_inventory; manager_name text; location_name text;
begin
  if private.current_app_role()<>'manager' then raise exception 'Manager access required'; end if;
  if not exists(select 1 from public.locations l where l.id=input_location_id and l.is_active and ((select u.all_locations from public.app_users u where u.id=actor) or exists(select 1 from public.manager_locations ml where ml.manager_id=actor and ml.location_id=l.id))) then raise exception 'Invalid manager location'; end if;
  if jsonb_array_length(input_items)=0 then raise exception 'Order requires items'; end if;
  select display_name into manager_name from public.app_users where id=actor;
  select name into location_name from public.locations where id=input_location_id;
  insert into public.orders(manager_id,location_id,manager_name_snapshot,location_name_snapshot,order_note) values(actor,input_location_id,manager_name,location_name,nullif(trim(input_note),'')) returning id into oid;
  for item in select * from jsonb_array_elements(input_items) loop
    pid:=(item->>'product_id')::uuid;qty:=(item->>'quantity')::int;
    if qty<=0 then raise exception 'Invalid quantity'; end if;
    select i.* into inventory from public.warehouse_inventory i join public.products p on p.id=i.product_id where i.product_id=pid and p.is_active and not p.is_archived for update of i;
    if not found or inventory.available<qty then raise exception 'Insufficient inventory for a requested product'; end if;
    insert into public.order_items(order_id,product_id,product_name_snapshot,sku_snapshot,unit_size_snapshot,item_location_snapshot,requested_quantity) select oid,p.id,p.name,p.sku,p.unit_size,p.item_location,qty from public.products p where p.id=pid;
    update public.warehouse_inventory set reserved=reserved+qty,updated_at=now() where product_id=pid;
    insert into public.inventory_movements(product_id,product_name_snapshot,quantity,action,actor_id,reason,related_order_id) select p.id,p.name,-qty,'reserved',actor,'Order submitted',oid from public.products p where p.id=pid;
  end loop;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data) values(actor,'order',oid,'submit',input_items);
  return oid;
end $$;

create or replace function public.warehouse_save_user(input_id uuid,input_display_name text,input_role public.app_role,input_pin text,input_location_ids uuid[],input_all_locations boolean,input_is_active boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); saved uuid; existing_hash text; clean_location_ids uuid[];
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  if trim(coalesce(input_display_name,''))='' then raise exception 'Display name is required'; end if;
  clean_location_ids:=coalesce((select array_agg(distinct id) from unnest(coalesce(input_location_ids,array[]::uuid[])) id),array[]::uuid[]);
  if input_role='manager' and not coalesce(input_all_locations,false) and cardinality(clean_location_ids)=0 then raise exception 'Managers require at least one location'; end if;
  if exists(select 1 from unnest(clean_location_ids) id where not exists(select 1 from public.locations l where l.id=id and l.is_active)) then raise exception 'A selected location is unavailable'; end if;
  if input_pin is not null and input_pin !~ '^\d{4}$' then raise exception 'PIN must contain exactly 4 digits'; end if;
  if input_pin is not null and exists(select 1 from public.app_users u where u.id is distinct from input_id and u.access_code_hash=extensions.crypt(input_pin,u.access_code_hash)) then raise exception 'That access code is already in use'; end if;
  if input_id is null then
    if input_pin is null then raise exception 'A PIN is required for new users'; end if;
    insert into public.app_users(display_name,role,access_code_hash,is_active,all_locations,created_by) values(trim(input_display_name),input_role,extensions.crypt(input_pin,extensions.gen_salt('bf',12)),input_is_active,input_role='manager' and coalesce(input_all_locations,false),actor) returning id into saved;
  else
    select access_code_hash into existing_hash from public.app_users where id=input_id for update;
    if not found then raise exception 'Employee not found'; end if;
    update public.app_users set display_name=trim(input_display_name),role=input_role,access_code_hash=case when input_pin is null then existing_hash else extensions.crypt(input_pin,extensions.gen_salt('bf',12)) end,is_active=input_is_active,all_locations=input_role='manager' and coalesce(input_all_locations,false),updated_at=now() where id=input_id returning id into saved;
  end if;
  delete from public.manager_locations where manager_id=saved;
  if input_role='manager' and not coalesce(input_all_locations,false) then insert into public.manager_locations(manager_id,location_id) select saved,id from unnest(clean_location_ids) id; end if;
  if not input_is_active then delete from public.app_user_sessions where app_user_id=saved; end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data) values(actor,'app_user',saved,case when input_id is null then 'create' else 'update' end,jsonb_build_object('role',input_role,'all_locations',coalesce(input_all_locations,false),'location_ids',clean_location_ids));
  return saved;
end $$;

create or replace function public.warehouse_bulk_adjust_inventory(input_product_ids uuid[],input_quantity integer,input_reason text)
returns integer language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); selected_id uuid; inventory public.warehouse_inventory; changed integer:=0; clean_ids uuid[];
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  clean_ids:=coalesce((select array_agg(distinct id order by id) from unnest(coalesce(input_product_ids,array[]::uuid[])) id),array[]::uuid[]);
  if cardinality(clean_ids)=0 then raise exception 'Select at least one product'; end if;
  if input_quantity is null or input_quantity=0 then raise exception 'Quantity change cannot be zero'; end if;
  if trim(coalesce(input_reason,''))='' then raise exception 'Adjustment reason is required'; end if;
  if exists(select 1 from unnest(clean_ids) id where not exists(select 1 from public.products p where p.id=id and p.is_active and not p.is_archived)) then raise exception 'A selected product is unavailable'; end if;
  foreach selected_id in array clean_ids loop
    select wi.* into inventory from public.warehouse_inventory wi where wi.product_id=selected_id for update;
    if not found then
      if input_quantity<0 then raise exception 'Adjustment would make on-hand inventory negative'; end if;
      insert into public.warehouse_inventory(product_id,on_hand) values(selected_id,input_quantity) returning * into inventory;
    else
      if inventory.on_hand+input_quantity<inventory.reserved then raise exception 'Adjustment would reduce stock below reserved inventory'; end if;
      update public.warehouse_inventory set on_hand=on_hand+input_quantity,updated_at=now() where product_id=selected_id returning * into inventory;
    end if;
    insert into public.inventory_movements(product_id,quantity,action,actor_id,reason) values(selected_id,input_quantity,'adjusted',actor,trim(input_reason));
    changed:=changed+1;
  end loop;
  insert into public.audit_logs(actor_id,entity_type,action,new_data) values(actor,'inventory','bulk_adjust',jsonb_build_object('product_ids',clean_ids,'quantity',input_quantity,'reason',trim(input_reason)));
  return changed;
end $$;

revoke all on function public.warehouse_save_user(uuid,text,public.app_role,text,uuid[],boolean,boolean),public.warehouse_bulk_adjust_inventory(uuid[],integer,text) from public,anon,authenticated;
grant execute on function public.warehouse_save_user(uuid,text,public.app_role,text,uuid[],boolean,boolean),public.warehouse_bulk_adjust_inventory(uuid[],integer,text) to authenticated;
revoke execute on function public.warehouse_save_user(uuid,text,public.app_role,text,uuid,boolean) from authenticated;

commit;
