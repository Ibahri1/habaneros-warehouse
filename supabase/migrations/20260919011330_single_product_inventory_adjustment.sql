begin;

create or replace function public.warehouse_adjust_inventory(
  input_product_id uuid,
  input_quantity integer,
  input_reason text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid:=private.current_app_user_id();
  inventory public.warehouse_inventory;
begin
  if private.current_app_role() not in ('fulfillment','admin') then
    raise exception 'Fulfillment access required';
  end if;
  if input_product_id is null then raise exception 'Select a product'; end if;
  if input_quantity is null or input_quantity=0 then raise exception 'Quantity change cannot be zero'; end if;
  if trim(coalesce(input_reason,''))='' then raise exception 'Adjustment reason is required'; end if;
  if not exists(
    select 1 from public.products p
    where p.id=input_product_id and p.is_active and not p.is_archived
  ) then raise exception 'Product is unavailable'; end if;

  select wi.* into inventory
  from public.warehouse_inventory wi
  where wi.product_id=input_product_id
  for update;

  if not found then
    if input_quantity<0 then raise exception 'Adjustment would make on-hand inventory negative'; end if;
    insert into public.warehouse_inventory(product_id,on_hand)
    values(input_product_id,input_quantity)
    returning * into inventory;
  else
    if inventory.on_hand+input_quantity<inventory.reserved then
      raise exception 'Adjustment would reduce stock below reserved inventory';
    end if;
    update public.warehouse_inventory
    set on_hand=on_hand+input_quantity,updated_at=now()
    where product_id=input_product_id
    returning * into inventory;
  end if;

  insert into public.inventory_movements(product_id,quantity,action,actor_id,reason)
  values(input_product_id,input_quantity,'adjusted',actor,trim(input_reason));

  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data)
  values(actor,'inventory',input_product_id,'adjust',jsonb_build_object(
    'quantity',input_quantity,
    'reason',trim(input_reason),
    'on_hand',inventory.on_hand,
    'reserved',inventory.reserved,
    'available',inventory.on_hand-inventory.reserved
  ));

  return jsonb_build_object(
    'on_hand',inventory.on_hand,
    'reserved',inventory.reserved,
    'available',inventory.on_hand-inventory.reserved
  );
end $$;

revoke all on function public.warehouse_adjust_inventory(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.warehouse_adjust_inventory(uuid,integer,text) to authenticated;

commit;
