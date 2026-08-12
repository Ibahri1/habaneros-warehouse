begin;

alter table public.orders add column if not exists hidden_from_queue_at timestamptz;
alter table public.orders add column if not exists hidden_from_queue_by uuid references public.app_users(id) on delete set null;
create index if not exists orders_hidden_from_queue_idx on public.orders(hidden_from_queue_at) where hidden_from_queue_at is not null;

create or replace function public.warehouse_hide_delivered_orders(input_order_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); changed integer;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  if input_order_ids is null or cardinality(input_order_ids)=0 then return 0; end if;
  with updated as (
    update public.orders set hidden_from_queue_at=now(),hidden_from_queue_by=actor,updated_at=now()
    where id=any(input_order_ids) and status='Delivered' and hidden_from_queue_at is null
    returning id,hidden_from_queue_at
  )
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data)
  select actor,'order',updated.id,'hide_from_queue',jsonb_build_object('hidden_from_queue_at',updated.hidden_from_queue_at) from updated;
  get diagnostics changed=row_count;
  return changed;
end $$;

create or replace function public.warehouse_get_queue_hidden_orders()
returns uuid[] language plpgsql stable security definer set search_path='' as $$
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Fulfillment access required'; end if;
  return coalesce((select array_agg(o.id) from public.orders o where o.status='Delivered' and o.hidden_from_queue_at is not null),array[]::uuid[]);
end $$;

revoke all on function public.warehouse_hide_delivered_orders(uuid[]),public.warehouse_get_queue_hidden_orders() from public,anon,authenticated;
grant execute on function public.warehouse_hide_delivered_orders(uuid[]),public.warehouse_get_queue_hidden_orders() to authenticated;

commit;
