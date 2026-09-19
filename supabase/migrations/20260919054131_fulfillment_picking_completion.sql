begin;

alter table public.order_items add column if not exists picked_at timestamptz;
alter table public.order_items add column if not exists picked_by uuid references public.app_users(id) on delete set null;
create index if not exists order_items_active_picking_idx on public.order_items(order_id,picked_at);

create or replace function public.warehouse_get_picking_progress()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'order_id',oi.order_id,'item_id',oi.id,'picked_at',oi.picked_at,'picked_by',oi.picked_by
  ) order by oi.order_id,oi.id) from public.order_items oi),'[]'::jsonb);
end $$;

create or replace function public.warehouse_set_order_item_picked(
  input_order_id uuid,input_item_id uuid,input_picked boolean,input_expected_picked_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); current_item public.order_items; order_status public.order_status; changed_at timestamptz;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  select status into order_status from public.orders where id=input_order_id for update;
  if order_status is null then raise exception 'Order not found'; end if;
  if order_status in ('Delivered','Cancelled') then raise exception 'Finalized orders cannot be changed'; end if;

  select * into current_item from public.order_items where id=input_item_id and order_id=input_order_id for update;
  if not found then raise exception 'Order item not found'; end if;
  if not input_picked and input_expected_picked_at is not null and current_item.picked_at is distinct from input_expected_picked_at then
    raise exception 'Picking progress changed on another device. Refresh and try again';
  end if;

  changed_at:=case when input_picked then coalesce(current_item.picked_at,clock_timestamp()) else null end;
  update public.order_items set picked_at=changed_at,picked_by=case when input_picked then actor else null end,updated_at=now() where id=input_item_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data,new_data)
  values(actor,'order_item',input_item_id,case when input_picked then 'picked' else 'unpicked' end,
    jsonb_build_object('picked_at',current_item.picked_at),jsonb_build_object('picked_at',changed_at,'order_id',input_order_id));
  return jsonb_build_object('order_id',input_order_id,'item_id',input_item_id,'picked_at',changed_at,'picked_by',case when input_picked then actor else null end);
end $$;

create or replace function public.warehouse_save_fulfillment_notes(input_order_id uuid,input_fulfillment_note text,input_delivery_note text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id();
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  update public.orders set fulfillment_note=nullif(trim(input_fulfillment_note),''),delivery_note=nullif(trim(input_delivery_note),''),updated_at=now() where id=input_order_id;
  if not found then raise exception 'Order not found'; end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data) values(actor,'order',input_order_id,'notes_update',jsonb_build_object('fulfillment_note',nullif(trim(input_fulfillment_note),''),'delivery_note',nullif(trim(input_delivery_note),'')));
end $$;

create or replace function public.warehouse_complete_picked_order(input_order_id uuid,input_fulfillment_note text default null,input_delivery_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); current_status public.order_status; item record; inv public.warehouse_inventory; item_count integer; unchecked_count integer;
begin
  if private.current_app_role()<>'fulfillment' then raise exception 'Fulfillment access required'; end if;
  select status into current_status from public.orders where id=input_order_id for update;
  if current_status is null then raise exception 'Order not found'; end if;
  if current_status='Delivered' then return jsonb_build_object('completed',false,'already_delivered',true,'status','Delivered'); end if;
  if current_status='Cancelled' then raise exception 'Cancelled orders cannot be completed'; end if;

  perform id from public.order_items where order_id=input_order_id order by id for update;
  select count(*),count(*) filter(where picked_at is null) into item_count,unchecked_count from public.order_items where order_id=input_order_id;
  if item_count=0 then raise exception 'Empty orders cannot be completed'; end if;
  if unchecked_count<>0 then raise exception 'Picking progress changed. Every item must be checked before delivery'; end if;

  for item in select * from public.order_items where order_id=input_order_id order by id loop
    if item.product_id is null then raise exception 'This order cannot be delivered because a product was permanently deleted'; end if;
    update public.warehouse_inventory set on_hand=on_hand-item.requested_quantity,reserved=reserved-item.requested_quantity,updated_at=now()
      where product_id=item.product_id and on_hand>=item.requested_quantity and reserved>=item.requested_quantity returning * into inv;
    if not found then raise exception 'Inventory reservation mismatch'; end if;
    update public.order_items set delivered_quantity=requested_quantity,cancelled_quantity=0,updated_at=now() where id=item.id;
    insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id)
      values(item.product_id,-item.requested_quantity,'delivered',actor,'Order delivered after picking completion',input_order_id);
  end loop;

  update public.orders set status='Delivered',fulfillment_note=nullif(trim(input_fulfillment_note),''),delivery_note=nullif(trim(input_delivery_note),''),delivered_at=now(),delivered_by=actor,hidden_from_queue_at=null,hidden_from_queue_by=null,updated_at=now() where id=input_order_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data,new_data)
    values(actor,'order',input_order_id,'fulfillment_complete',jsonb_build_object('status',current_status),jsonb_build_object('status','Delivered','checked_items',item_count));
  return jsonb_build_object('completed',true,'already_delivered',false,'status','Delivered');
end $$;

-- Keep the proven administrator correction implementation, but remove the
-- generic status endpoint from Fulfillment users.
alter function public.warehouse_update_order(uuid,public.order_status,text,text) rename to warehouse_update_order_admin_impl;
revoke all on function public.warehouse_update_order_admin_impl(uuid,public.order_status,text,text) from public,anon,authenticated;
create function public.warehouse_update_order(input_order_id uuid,input_status public.order_status,input_fulfillment_note text default null,input_delivery_note text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  perform public.warehouse_update_order_admin_impl(input_order_id,input_status,input_fulfillment_note,input_delivery_note);
end $$;

revoke all on function public.warehouse_get_picking_progress(),public.warehouse_set_order_item_picked(uuid,uuid,boolean,timestamptz),public.warehouse_save_fulfillment_notes(uuid,text,text),public.warehouse_complete_picked_order(uuid,text,text),public.warehouse_update_order(uuid,public.order_status,text,text) from public,anon,authenticated;
grant execute on function public.warehouse_get_picking_progress(),public.warehouse_set_order_item_picked(uuid,uuid,boolean,timestamptz),public.warehouse_save_fulfillment_notes(uuid,text,text),public.warehouse_complete_picked_order(uuid,text,text),public.warehouse_update_order(uuid,public.order_status,text,text) to authenticated;

commit;
