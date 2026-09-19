begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

alter table public.products alter column low_stock_threshold drop not null;
alter table public.products alter column low_stock_threshold drop default;

create table public.reorder_report_settings (
  singleton boolean primary key default true check(singleton),
  automatic_enabled boolean not null default false,
  weekdays smallint[] not null default array[]::smallint[],
  recipients text[] not null default array[]::text[],
  send_time time not null default time '14:00:00' check(send_time=time '14:00:00'),
  timezone text not null default 'America/Los_Angeles' check(timezone='America/Los_Angeles'),
  last_send_status text,
  last_send_at timestamptz,
  updated_by uuid references public.app_users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.reorder_report_settings(singleton) values(true) on conflict(singleton) do nothing;

create table public.reorder_report_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_type text not null check(trigger_type in ('manual','scheduled')),
  scheduled_run_key text unique,
  requested_by uuid references public.app_users(id) on delete set null,
  generated_at timestamptz not null default now(),
  expires_at timestamptz,
  item_count integer not null check(item_count>=0),
  recipients jsonb not null,
  snapshot jsonb not null,
  status text not null check(status in ('preview','sending','sent','partial','failed','uncertain','expired')),
  started_at timestamptz,
  finished_at timestamptz,
  safe_error text,
  created_at timestamptz not null default now()
);

create table public.reorder_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.reorder_report_runs(id) on delete cascade,
  recipient text not null,
  status text not null check(status in ('accepted','failed','uncertain')),
  attempts integer not null check(attempts between 1 and 3),
  accepted_at timestamptz,
  safe_error text,
  created_at timestamptz not null default now(),
  unique(run_id,recipient)
);

create index reorder_report_runs_created_idx on public.reorder_report_runs(created_at desc);
create index reorder_report_deliveries_run_idx on public.reorder_report_deliveries(run_id);

alter table public.reorder_report_settings enable row level security;
alter table public.reorder_report_runs enable row level security;
alter table public.reorder_report_deliveries enable row level security;

create or replace function private.reorder_snapshot()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id',p.id,
    'name',p.name,
    'category',coalesce(c.name,'Uncategorized'),
    'available',coalesce(wi.available,0)
  ) order by coalesce(c.name,'Uncategorized'),p.name),'[]'::jsonb)
  from public.products p
  left join public.categories c on c.id=p.category_id
  left join public.warehouse_inventory wi on wi.product_id=p.id
  where p.is_active and not p.is_archived
    and p.low_stock_threshold is not null
    and coalesce(wi.available,0)<=p.low_stock_threshold
$$;

create or replace function public.warehouse_reorder_get_admin_data()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id();
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  update public.reorder_report_runs set status='expired' where status='preview' and expires_at<=now();
  return jsonb_build_object(
    'settings',(select jsonb_build_object(
      'automatic_enabled',s.automatic_enabled,'weekdays',s.weekdays,'recipients',s.recipients,
      'send_time','14:00','timezone',s.timezone,'last_send_status',s.last_send_status,'last_send_at',s.last_send_at
    ) from public.reorder_report_settings s where s.singleton),
    'history',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'trigger_type',r.trigger_type,'generated_at',r.generated_at,'item_count',r.item_count,
      'status',r.status,'recipients',r.recipients,'finished_at',r.finished_at,'safe_error',r.safe_error,
      'deliveries',coalesce((select jsonb_agg(jsonb_build_object('recipient',d.recipient,'status',d.status,'attempts',d.attempts,'accepted_at',d.accepted_at,'safe_error',d.safe_error) order by d.recipient) from public.reorder_report_deliveries d where d.run_id=r.id),'[]'::jsonb)
    ) order by r.created_at desc) from (select * from public.reorder_report_runs order by created_at desc limit 20) r),'[]'::jsonb)
  );
end $$;

create or replace function public.warehouse_reorder_save_settings(input_automatic_enabled boolean,input_weekdays smallint[],input_recipients text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); clean_days smallint[]; clean_recipients text[];
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  clean_days:=coalesce((select array_agg(distinct day order by day) from unnest(coalesce(input_weekdays,array[]::smallint[])) day where day between 0 and 6),array[]::smallint[]);
  if cardinality(clean_days)<>cardinality(coalesce(input_weekdays,array[]::smallint[])) then raise exception 'Weekdays must be unique values from 0 through 6'; end if;
  clean_recipients:=coalesce((select array_agg(address order by address) from (select distinct lower(trim(value)) address from unnest(coalesce(input_recipients,array[]::text[])) value where trim(value)<>'') clean),array[]::text[]);
  if exists(select 1 from unnest(clean_recipients) address where address !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' collate "C") then raise exception 'Enter valid recipient email addresses'; end if;
  if coalesce(input_automatic_enabled,false) and (cardinality(clean_days)=0 or cardinality(clean_recipients)=0) then raise exception 'Automatic sending requires at least one weekday and recipient'; end if;
  update public.reorder_report_settings set automatic_enabled=coalesce(input_automatic_enabled,false),weekdays=clean_days,recipients=clean_recipients,updated_by=actor,updated_at=now() where singleton;
  insert into public.audit_logs(actor_id,entity_type,action,new_data) values(actor,'reorder_report','settings_update',jsonb_build_object('automatic_enabled',coalesce(input_automatic_enabled,false),'weekdays',clean_days,'recipient_count',cardinality(clean_recipients)));
  return public.warehouse_reorder_get_admin_data();
end $$;

create or replace function public.warehouse_reorder_create_preview()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); report jsonb; addresses text[]; saved public.reorder_report_runs;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  select recipients into addresses from public.reorder_report_settings where singleton;
  if cardinality(addresses)=0 then raise exception 'Add at least one recipient before generating a report'; end if;
  report:=private.reorder_snapshot();
  insert into public.reorder_report_runs(trigger_type,requested_by,expires_at,item_count,recipients,snapshot,status)
  values('manual',actor,now()+interval '30 minutes',jsonb_array_length(report),to_jsonb(addresses),report,'preview') returning * into saved;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data) values(actor,'reorder_report',saved.id,'preview_created',jsonb_build_object('item_count',saved.item_count,'recipient_count',cardinality(addresses),'expires_at',saved.expires_at));
  return jsonb_build_object('id',saved.id,'generated_at',saved.generated_at,'expires_at',saved.expires_at,'item_count',saved.item_count,'recipients',saved.recipients,'snapshot',saved.snapshot,'status',saved.status);
end $$;

create or replace function public.warehouse_reorder_claim_manual(input_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); run public.reorder_report_runs;
begin
  if private.current_app_role()<>'admin' then raise exception 'Administrator access required'; end if;
  select * into run from public.reorder_report_runs where id=input_run_id and trigger_type='manual' and requested_by=actor for update;
  if not found then raise exception 'Report preview not found'; end if;
  if run.status<>'preview' then return jsonb_build_object('claimed',false,'id',run.id,'status',run.status); end if;
  if run.expires_at<=now() then update public.reorder_report_runs set status='expired' where id=run.id; raise exception 'Report preview expired; generate a new preview'; end if;
  update public.reorder_report_runs set status='sending',started_at=now() where id=run.id returning * into run;
  return jsonb_build_object('claimed',true,'id',run.id,'generated_at',run.generated_at,'item_count',run.item_count,'recipients',run.recipients,'snapshot',run.snapshot,'status',run.status);
end $$;

create or replace function public.warehouse_reorder_claim_scheduled(input_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings public.reorder_report_settings; local_now timestamp; run_key text; report jsonb; saved public.reorder_report_runs;
begin
  select * into settings from public.reorder_report_settings where singleton for update;
  local_now:=timezone(settings.timezone,input_now);
  if not settings.automatic_enabled or cardinality(settings.weekdays)=0 or cardinality(settings.recipients)=0 then return null; end if;
  if not extract(dow from local_now)::smallint=any(settings.weekdays) or local_now::time<time '14:00' or local_now::time>=time '14:10' then return null; end if;
  run_key:=to_char(local_now,'YYYY-MM-DD');
  report:=private.reorder_snapshot();
  insert into public.reorder_report_runs(trigger_type,scheduled_run_key,item_count,recipients,snapshot,status,started_at)
  values('scheduled',run_key,jsonb_array_length(report),to_jsonb(settings.recipients),report,'sending',now())
  on conflict(scheduled_run_key) do nothing returning * into saved;
  if saved.id is null then return null; end if;
  return jsonb_build_object('claimed',true,'id',saved.id,'generated_at',saved.generated_at,'item_count',saved.item_count,'recipients',saved.recipients,'snapshot',saved.snapshot,'status',saved.status);
end $$;

create or replace function public.warehouse_reorder_record_delivery(input_run_id uuid,input_recipient text,input_status text,input_attempts integer,input_safe_error text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if input_status not in ('accepted','failed','uncertain') then raise exception 'Invalid delivery status'; end if;
  insert into public.reorder_report_deliveries(run_id,recipient,status,attempts,accepted_at,safe_error)
  values(input_run_id,lower(trim(input_recipient)),input_status,input_attempts,case when input_status='accepted' then now() end,left(nullif(input_safe_error,''),500))
  on conflict(run_id,recipient) do nothing;
end $$;

create or replace function public.warehouse_reorder_finish_run(input_run_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare final_status text; summary text;
begin
  select case
    when bool_or(status='uncertain') then 'uncertain'
    when bool_and(status='accepted') then 'sent'
    when bool_and(status='failed') then 'failed'
    else 'partial' end,
    string_agg(case when status='failed' then recipient||': '||coalesce(safe_error,'Failed') when status='uncertain' then recipient||': delivery uncertain' end,'; ')
  into final_status,summary from public.reorder_report_deliveries where run_id=input_run_id;
  final_status:=coalesce(final_status,'failed');
  update public.reorder_report_runs set status=final_status,finished_at=now(),safe_error=left(summary,1000) where id=input_run_id;
  update public.reorder_report_settings set last_send_status=final_status,last_send_at=now() where singleton;
  return final_status;
end $$;

drop function if exists public.warehouse_save_product(uuid,uuid,text,text,text,text,integer,text,text);
create function public.warehouse_save_product(input_id uuid,input_category_id uuid,input_name text,input_sku text,input_description text,input_unit_size text,input_low_stock_threshold integer,input_image_path text,input_item_location text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_app_user_id(); saved uuid;
begin
  if private.current_app_role() not in ('fulfillment','admin') then raise exception 'Staff access required'; end if;
  if trim(coalesce(input_name,''))='' then raise exception 'Product name is required'; end if;
  if input_low_stock_threshold is not null and input_low_stock_threshold<0 then raise exception 'Low-stock threshold cannot be negative'; end if;
  if input_id is null then
    insert into public.products(category_id,name,sku,description,unit_size,low_stock_threshold,image_path,item_location,is_active,is_archived)
    values(input_category_id,trim(input_name),nullif(trim(input_sku),''),nullif(trim(input_description),''),nullif(trim(input_unit_size),''),input_low_stock_threshold,nullif(trim(input_image_path),''),nullif(trim(input_item_location),''),true,false) returning id into saved;
    insert into public.warehouse_inventory(product_id) values(saved) on conflict do nothing;
  else
    update public.products set category_id=input_category_id,name=trim(input_name),sku=nullif(trim(input_sku),''),description=nullif(trim(input_description),''),unit_size=nullif(trim(input_unit_size),''),low_stock_threshold=input_low_stock_threshold,image_path=nullif(trim(input_image_path),''),item_location=nullif(trim(input_item_location),''),is_active=true,is_archived=false,updated_at=now() where id=input_id returning id into saved;
    if saved is null then raise exception 'Product not found'; end if;
  end if;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,new_data) values(actor,'product',saved,case when input_id is null then 'create' else 'update' end,jsonb_build_object('name',trim(input_name),'low_stock_threshold',input_low_stock_threshold));
  return saved;
end $$;

revoke all on table public.reorder_report_settings,public.reorder_report_runs,public.reorder_report_deliveries from public,anon,authenticated;
revoke all on function public.warehouse_reorder_get_admin_data(),public.warehouse_reorder_save_settings(boolean,smallint[],text[]),public.warehouse_reorder_create_preview(),public.warehouse_reorder_claim_manual(uuid),public.warehouse_reorder_claim_scheduled(timestamptz),public.warehouse_reorder_record_delivery(uuid,text,text,integer,text),public.warehouse_reorder_finish_run(uuid) from public,anon,authenticated;
grant execute on function public.warehouse_reorder_get_admin_data(),public.warehouse_reorder_save_settings(boolean,smallint[],text[]),public.warehouse_reorder_create_preview(),public.warehouse_reorder_claim_manual(uuid) to authenticated;
grant execute on function public.warehouse_reorder_claim_scheduled(timestamptz),public.warehouse_reorder_record_delivery(uuid,text,text,integer,text),public.warehouse_reorder_finish_run(uuid) to service_role;
revoke all on function public.warehouse_save_product(uuid,uuid,text,text,text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.warehouse_save_product(uuid,uuid,text,text,text,text,integer,text,text) to authenticated;

-- Missed-run policy: the dispatcher only claims the current Pacific date during
-- the 14:00-14:09 window. It never backfills older dates, preventing bursts.
-- Create Vault secrets named project_url and reorder_scheduler_secret, then run:
-- select cron.schedule('warehouse-reorder-reports','*/5 * * * *',$job$
--   select net.http_post(
--     url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/reorder-reports',
--     headers := jsonb_build_object('Content-Type','application/json','x-reorder-scheduler-secret',(select decrypted_secret from vault.decrypted_secrets where name='reorder_scheduler_secret')),
--     body := '{"action":"scheduled"}'::jsonb
--   );
-- $job$);

commit;
