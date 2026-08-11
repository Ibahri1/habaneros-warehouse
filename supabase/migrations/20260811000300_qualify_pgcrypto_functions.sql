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

revoke all on function public.warehouse_login_with_pin(text),public.warehouse_save_user(uuid,text,public.app_role,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.warehouse_login_with_pin(text),public.warehouse_save_user(uuid,text,public.app_role,text,uuid,boolean) to authenticated;
