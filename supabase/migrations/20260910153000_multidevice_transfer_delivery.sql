-- Treat a file/voice relay as one logical queue item while giving every active
-- recipient device its own E2E key envelope. Completion atomically removes the
-- last envelope and ciphertext only after all intended devices consumed it.
alter table public.mf_transfer_deliveries add column if not exists logical_id uuid;
update public.mf_transfer_deliveries set logical_id = id where logical_id is null;
alter table public.mf_transfer_deliveries alter column logical_id set not null;
create index if not exists mf_transfer_logical_idx on public.mf_transfer_deliveries(logical_id);
create unique index if not exists mf_transfer_logical_device_uidx
  on public.mf_transfer_deliveries(logical_id, recipient_device_id) where recipient_device_id is not null;

create or replace function public.mf_pending_relay_count(other_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select count(*) from (
    select coalesce(s.logical_id, s.id) as item
    from public.mf_snaps s
    where s.sender_id = auth.uid() and s.recipient_id = other_id
      and s.delivery like 'relay%' and s.viewed_at is null and s.expires_at > now()
    group by coalesce(s.logical_id, s.id)
    union all
    select d.logical_id from public.mf_transfer_deliveries d
    where d.sender_id = auth.uid() and d.recipient_id = other_id and d.expires_at > now()
    group by d.logical_id
  ) pending;
$$;

-- Serialize cap checks for a sender/recipient pair so two browser tabs cannot
-- both observe slot 10 as available. Extra rows for the same logical item are
-- allowed because they are device envelopes, not additional queued items.
create or replace function public.mf_enforce_transfer_relay_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.sender_id::text || ':' || new.recipient_id::text, 0));
  if not exists (
    select 1 from public.mf_transfer_deliveries d
    where d.sender_id = new.sender_id and d.recipient_id = new.recipient_id and d.logical_id = new.logical_id
  ) and public.mf_pending_relay_count(new.recipient_id) >= 10 then
    raise exception 'relay queue limit reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.mf_enforce_snap_relay_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.delivery not like 'relay%' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.sender_id::text || ':' || new.recipient_id::text, 0));
  if not exists (
    select 1 from public.mf_snaps s where s.sender_id = new.sender_id and s.recipient_id = new.recipient_id
      and coalesce(s.logical_id, s.id) = coalesce(new.logical_id, new.id)
  ) and public.mf_pending_relay_count(new.recipient_id) >= 10 then
    raise exception 'relay queue limit reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists mf_snap_relay_limit on public.mf_snaps;
create trigger mf_snap_relay_limit before insert on public.mf_snaps
for each row execute function public.mf_enforce_snap_relay_limit();

create or replace function public.mf_complete_transfer(delivery_id uuid, device_id uuid)
returns boolean language plpgsql security definer set search_path = public, storage as $$
declare target public.mf_transfer_deliveries; remaining bigint;
begin
  select * into target from public.mf_transfer_deliveries d
  where d.id = mf_complete_transfer.delivery_id and d.recipient_id = auth.uid()
    and (d.recipient_device_id is null or d.recipient_device_id = mf_complete_transfer.device_id)
  for update;
  if not found then return false; end if;
  if target.recipient_device_id is not null and not exists (
    select 1 from public.mf_devices d where d.id = mf_complete_transfer.device_id
      and d.user_id = auth.uid() and d.revoked_at is null
  ) then return false; end if;
  delete from public.mf_transfer_deliveries where id = target.id;
  select count(*) into remaining from public.mf_transfer_deliveries where relay_id = target.relay_id;
  if remaining = 0 then
    delete from storage.objects where bucket_id = 'mf-snaps' and name = target.relay_id::text;
    delete from public.mf_relay_payloads where id = target.relay_id;
  end if;
  return true;
end;
$$;
revoke all on function public.mf_complete_transfer(uuid, uuid) from public, anon;
grant execute on function public.mf_complete_transfer(uuid, uuid) to authenticated;
