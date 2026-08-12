begin;

-- Delivered and Cancelled are operationally reversible. This function locks the
-- order and each inventory row so the inventory reversal, new status effect,
-- item quantities, queue visibility, and audit records commit atomically.
create or replace function public.warehouse_update_order(input_order_id uuid,input_status public.order_status,input_fulfillment_note text default null,input_delivery_note text default null)
returns void language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=private.current_app_user_id();
  old_status public.order_status;
  old_hidden_at timestamptz;
  item record;
  inv public.warehouse_inventory;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;

  select status,hidden_from_queue_at into old_status,old_hidden_at
  from public.orders where id=input_order_id for update;
  if old_status is null then raise exception 'Order not found'; end if;

  if input_status<>old_status then
    -- First undo the previous finalized state and return the order to its
    -- original reserved state. Balancing movements make corrections auditable.
    if old_status='Delivered' then
      for item in select * from public.order_items where order_id=input_order_id for update loop
        if item.product_id is null then raise exception 'This order cannot be reopened because a product was permanently deleted'; end if;
        update public.warehouse_inventory
          set on_hand=on_hand+item.requested_quantity,
              reserved=reserved+item.requested_quantity,
              updated_at=now()
          where product_id=item.product_id returning * into inv;
        if not found then raise exception 'Inventory record missing for an order item'; end if;
        update public.order_items set delivered_quantity=0,updated_at=now() where id=item.id;
        insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id)
          values(item.product_id,item.requested_quantity,'delivered',actor,'Delivery reversed after status correction',input_order_id);
      end loop;
    elsif old_status='Cancelled' then
      for item in select * from public.order_items where order_id=input_order_id for update loop
        if item.product_id is null then raise exception 'This order cannot be reopened because a product was permanently deleted'; end if;
        update public.warehouse_inventory
          set reserved=reserved+item.requested_quantity,updated_at=now()
          where product_id=item.product_id and available>=item.requested_quantity
          returning * into inv;
        if not found then raise exception 'Insufficient available inventory to reopen this cancelled order'; end if;
        update public.order_items set cancelled_quantity=0,updated_at=now() where id=item.id;
        insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id)
          values(item.product_id,-item.requested_quantity,'cancelled',actor,'Cancellation reversed after status correction',input_order_id);
      end loop;
    end if;

    -- Apply the new finalized state after any old finalized effect was undone.
    if input_status='Delivered' then
      for item in select * from public.order_items where order_id=input_order_id for update loop
        if item.product_id is null then raise exception 'This order cannot be delivered because a product was permanently deleted'; end if;
        update public.warehouse_inventory
          set on_hand=on_hand-item.requested_quantity,
              reserved=reserved-item.requested_quantity,
              updated_at=now()
          where product_id=item.product_id
            and on_hand>=item.requested_quantity
            and reserved>=item.requested_quantity
          returning * into inv;
        if not found then raise exception 'Inventory reservation mismatch'; end if;
        update public.order_items set delivered_quantity=requested_quantity,cancelled_quantity=0,updated_at=now() where id=item.id;
        insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id)
          values(item.product_id,-item.requested_quantity,'delivered',actor,'Order delivered',input_order_id);
      end loop;
    elsif input_status='Cancelled' then
      for item in select * from public.order_items where order_id=input_order_id for update loop
        if item.product_id is null then raise exception 'This order cannot be cancelled because a product was permanently deleted'; end if;
        update public.warehouse_inventory
          set reserved=reserved-item.requested_quantity,updated_at=now()
          where product_id=item.product_id and reserved>=item.requested_quantity
          returning * into inv;
        if not found then raise exception 'Inventory reservation mismatch'; end if;
        update public.order_items set cancelled_quantity=requested_quantity,delivered_quantity=0,updated_at=now() where id=item.id;
        insert into public.inventory_movements(product_id,quantity,action,actor_id,reason,related_order_id)
          values(item.product_id,item.requested_quantity,'cancelled',actor,'Order cancelled',input_order_id);
      end loop;
    else
      update public.order_items set delivered_quantity=0,cancelled_quantity=0,updated_at=now() where order_id=input_order_id;
    end if;
  end if;

  update public.orders set
    status=input_status,
    fulfillment_note=nullif(trim(input_fulfillment_note),''),
    delivery_note=nullif(trim(input_delivery_note),''),
    delivered_at=case when input_status='Delivered' then case when old_status='Delivered' then delivered_at else now() end else null end,
    delivered_by=case when input_status='Delivered' then case when old_status='Delivered' then delivered_by else actor end else null end,
    hidden_from_queue_at=case when input_status<>old_status then null else hidden_from_queue_at end,
    hidden_from_queue_by=case when input_status<>old_status then null else hidden_from_queue_by end,
    updated_at=now()
  where id=input_order_id;

  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data,new_data)
  values(actor,'order',input_order_id,'update',
    jsonb_build_object('status',old_status,'hidden_from_queue_at',old_hidden_at),
    jsonb_build_object('status',input_status,'hidden_from_queue_at',case when input_status<>old_status then null else old_hidden_at end));
end $$;

-- Keep the existing RPC name for deployment compatibility, but extend it to
-- both finalized statuses.
create or replace function public.warehouse_hide_delivered_orders(input_order_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); changed integer;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  if input_order_ids is null or cardinality(input_order_ids)=0 then return 0; end if;
  with updated as (
    update public.orders set hidden_from_queue_at=now(),hidden_from_queue_by=actor,updated_at=now()
    where id=any(input_order_ids) and status in ('Delivered','Cancelled') and hidden_from_queue_at is null
    returning id,status,hidden_from_queue_at
  )
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data)
  select actor,'order',updated.id,'hide_from_queue',jsonb_build_object('status',updated.status,'hidden_from_queue_at',updated.hidden_from_queue_at) from updated;
  get diagnostics changed=row_count;
  return changed;
end $$;

create or replace function public.warehouse_get_queue_hidden_orders()
returns uuid[] language plpgsql stable security definer set search_path='' as $$
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  return coalesce((select array_agg(o.id) from public.orders o where o.status in ('Delivered','Cancelled') and o.hidden_from_queue_at is not null),array[]::uuid[]);
end $$;

revoke all on function public.warehouse_update_order(uuid,public.order_status,text,text),public.warehouse_hide_delivered_orders(uuid[]),public.warehouse_get_queue_hidden_orders() from public,anon,authenticated;
grant execute on function public.warehouse_update_order(uuid,public.order_status,text,text),public.warehouse_hide_delivered_orders(uuid[]),public.warehouse_get_queue_hidden_orders() to authenticated;

commit;
