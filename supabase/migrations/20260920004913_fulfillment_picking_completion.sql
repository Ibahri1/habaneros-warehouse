begin;

alter table public.order_items add column if not exists picked_at timestamptz;
alter table public.order_items add column if not exists picked_by uuid references public.app_users(id) on delete set null;

-- Keep the established inventory/status implementation, but remove direct
-- fulfillment access to the generic status endpoint.
alter function public.warehouse_update_order(uuid,public.order_status,text,text)
  rename to warehouse_update_order_admin_impl;
revoke all on function public.warehouse_update_order_admin_impl(uuid,public.order_status,text,text)
  from public,anon,authenticated;

create function public.warehouse_update_order(input_order_id uuid,input_status public.order_status,input_fulfillment_note text default null,input_delivery_note text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if private.current_app_role() is distinct from 'admin'::public.app_role then raise exception 'Administrator access required'; end if;
  perform public.warehouse_update_order_admin_impl(input_order_id,input_status,input_fulfillment_note,input_delivery_note);
end $$;

create function public.warehouse_get_picking_progress()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if private.current_app_role() is null or private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'picked_at',i.picked_at,'picked_by',i.picked_by))
    from public.order_items i join public.orders o on o.id=i.order_id), '[]'::jsonb);
end $$;

create function public.warehouse_set_order_item_picked(input_order_id uuid,input_item_id uuid,input_picked boolean,input_expected_picked_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); current_status public.order_status; item public.order_items; changed_at timestamptz;
begin
  if private.current_app_role() is null or private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  if input_picked is null then raise exception 'Picked state is required'; end if;
  select status into current_status from public.orders where id=input_order_id for update;
  if current_status is null then raise exception 'Order not found'; end if;
  if current_status in ('Delivered','Cancelled') then raise exception 'This order is already complete'; end if;
  select * into item from public.order_items where id=input_item_id and order_id=input_order_id for update;
  if not found then raise exception 'Order item not found'; end if;
  if item.picked_at is distinct from input_expected_picked_at then raise exception 'Picking progress changed on another device. Refresh the order and try again'; end if;
  if (item.picked_at is not null) = input_picked then
    return jsonb_build_object('id',item.id,'picked_at',item.picked_at,'picked_by',item.picked_by);
  end if;
  changed_at:=case when input_picked then clock_timestamp() else null end;
  update public.order_items set picked_at=changed_at,picked_by=case when input_picked then actor else null end,updated_at=now()
    where id=item.id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data,new_data)
    values(actor,'order_item',item.id,'set_picked',jsonb_build_object('picked_at',item.picked_at),jsonb_build_object('picked_at',changed_at));
  return jsonb_build_object('id',item.id,'picked_at',changed_at,'picked_by',case when input_picked then actor else null end);
end $$;

-- The order-row lock serializes item changes and delivery. The existing
-- inventory-safe implementation performs deductions, status, and audit once.
create function public.warehouse_complete_picked_order(input_order_id uuid,input_fulfillment_note text default null,input_delivery_note text default null)
returns text language plpgsql security definer set search_path='' as $$
declare current_status public.order_status; item_count integer; unchecked_count integer;
begin
  if private.current_app_role() is distinct from 'fulfillment'::public.app_role then raise exception 'Fulfillment access required'; end if;
  select status into current_status from public.orders where id=input_order_id for update;
  if current_status is null then raise exception 'Order not found'; end if;
  if current_status='Delivered' then return 'already_delivered'; end if;
  if current_status='Cancelled' then raise exception 'This order was cancelled'; end if;
  perform 1 from public.order_items where order_id=input_order_id order by id for update;
  select count(*),count(*) filter(where picked_at is null) into item_count,unchecked_count
    from public.order_items where order_id=input_order_id;
  if item_count=0 then raise exception 'An empty order cannot be completed'; end if;
  if unchecked_count>0 then raise exception 'Not all items are checked. Refresh the order and try again'; end if;
  perform public.warehouse_update_order_admin_impl(input_order_id,'Delivered',input_fulfillment_note,input_delivery_note);
  return 'delivered';
end $$;

-- Fulfillment may save notes without gaining access to arbitrary statuses.
create function public.warehouse_save_fulfillment_notes(input_order_id uuid,input_fulfillment_note text,input_delivery_note text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); current_status public.order_status;
begin
  if private.current_app_role() is distinct from 'fulfillment'::public.app_role then raise exception 'Fulfillment access required'; end if;
  select status into current_status from public.orders where id=input_order_id for update;
  if current_status is null then raise exception 'Order not found'; end if;
  if current_status in ('Delivered','Cancelled') then raise exception 'This order is already complete'; end if;
  update public.orders set fulfillment_note=nullif(trim(input_fulfillment_note),''),delivery_note=nullif(trim(input_delivery_note),''),updated_at=now() where id=input_order_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data)
    values(actor,'order',input_order_id,'save_notes',jsonb_build_object('fulfillment_note',input_fulfillment_note,'delivery_note',input_delivery_note));
end $$;

revoke all on function public.warehouse_update_order(uuid,public.order_status,text,text),public.warehouse_get_picking_progress(),public.warehouse_set_order_item_picked(uuid,uuid,boolean,timestamptz),public.warehouse_complete_picked_order(uuid,text,text),public.warehouse_save_fulfillment_notes(uuid,text,text) from public,anon,authenticated;
grant execute on function public.warehouse_update_order(uuid,public.order_status,text,text),public.warehouse_get_picking_progress(),public.warehouse_set_order_item_picked(uuid,uuid,boolean,timestamptz),public.warehouse_complete_picked_order(uuid,text,text),public.warehouse_save_fulfillment_notes(uuid,text,text) to authenticated;

commit;
