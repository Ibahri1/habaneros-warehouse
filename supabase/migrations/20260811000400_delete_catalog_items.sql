create or replace function public.warehouse_delete_product(input_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); product_name text;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  select name into product_name from public.products where id=input_id for update;
  if product_name is null then raise exception 'Product not found'; end if;
  if exists(select 1 from public.order_items where product_id=input_id or substitution_product_id=input_id)
     or exists(select 1 from public.inventory_movements where product_id=input_id) then
    raise exception 'This product has warehouse history and cannot be permanently deleted. Archive it instead.';
  end if;
  if exists(select 1 from public.warehouse_inventory where product_id=input_id and (on_hand<>0 or reserved<>0)) then
    raise exception 'Inventory must be zero before this product can be deleted.';
  end if;
  delete from public.warehouse_inventory where product_id=input_id;
  delete from public.products where id=input_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data)
  values(actor,'product',input_id,'delete',jsonb_build_object('name',product_name));
end $$;

create or replace function public.warehouse_delete_category(input_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid:=private.current_app_user_id(); category_name text;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  select name into category_name from public.categories where id=input_id for update;
  if category_name is null then raise exception 'Category not found'; end if;
  if exists(select 1 from public.products where category_id=input_id) then
    raise exception 'Move or delete the products in this category first.';
  end if;
  delete from public.categories where id=input_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,old_data)
  values(actor,'category',input_id,'delete',jsonb_build_object('name',category_name));
end $$;

revoke all on function public.warehouse_delete_product(uuid),public.warehouse_delete_category(uuid) from public,anon,authenticated;
grant execute on function public.warehouse_delete_product(uuid),public.warehouse_delete_category(uuid) to authenticated;
