-- Generic E2E-encrypted relay deliveries for chat attachments and voice clips.
-- The queue limit is enforced per sender/recipient pair by the client and the
-- count RPC; ciphertext lives in the existing private mf-snaps bucket.
create table if not exists public.mf_transfer_deliveries (
  id uuid primary key,
  relay_id uuid not null references public.mf_relay_payloads(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  recipient_device_id uuid references public.mf_devices(id) on delete cascade,
  name text not null default 'file',
  mime text not null default 'application/octet-stream',
  media_kind text not null default 'file',
  bytes bigint not null default 0,
  wrapped_key text not null,
  iv text not null,
  eph_pub text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);
create index if not exists mf_transfer_recipient_idx on public.mf_transfer_deliveries(recipient_id, created_at);
create index if not exists mf_transfer_sender_recipient_idx on public.mf_transfer_deliveries(sender_id, recipient_id, expires_at);
alter table public.mf_transfer_deliveries enable row level security;
drop policy if exists "mf_transfer_select" on public.mf_transfer_deliveries;
create policy "mf_transfer_select" on public.mf_transfer_deliveries for select using (auth.uid() in (sender_id, recipient_id));
drop policy if exists "mf_transfer_insert" on public.mf_transfer_deliveries;
create policy "mf_transfer_insert" on public.mf_transfer_deliveries for insert with check (auth.uid() = sender_id);
drop policy if exists "mf_transfer_delete" on public.mf_transfer_deliveries;
create policy "mf_transfer_delete" on public.mf_transfer_deliveries for delete using (auth.uid() in (sender_id, recipient_id));

create or replace function public.mf_pending_relay_count(other_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select count(*) from (
    select coalesce(s.logical_id, s.id) as item
    from public.mf_snaps s
    where s.sender_id = auth.uid() and s.recipient_id = other_id
      and s.delivery like 'relay%' and s.viewed_at is null and s.expires_at > now()
    group by coalesce(s.logical_id, s.id)
    union all
    select d.id from public.mf_transfer_deliveries d
    where d.sender_id = auth.uid() and d.recipient_id = other_id and d.expires_at > now()
  ) pending;
$$;
revoke all on function public.mf_pending_relay_count(uuid) from public, anon;
grant execute on function public.mf_pending_relay_count(uuid) to authenticated;

create or replace function public.mf_enforce_transfer_relay_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.mf_pending_relay_count(new.recipient_id) >= 10 then
    raise exception 'relay queue limit reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists mf_transfer_relay_limit on public.mf_transfer_deliveries;
create trigger mf_transfer_relay_limit before insert on public.mf_transfer_deliveries
for each row execute function public.mf_enforce_transfer_relay_limit();

drop policy if exists "mf_relay_payloads_select" on public.mf_relay_payloads;
create policy "mf_relay_payloads_select" on public.mf_relay_payloads for select using (
  auth.uid() = sender_id or
  exists (select 1 from public.mf_snaps s where s.relay_id = mf_relay_payloads.id and s.recipient_id = auth.uid()) or
  exists (select 1 from public.mf_transfer_deliveries d where d.relay_id = mf_relay_payloads.id and d.recipient_id = auth.uid())
);
create or replace function public.mf_can_cleanup_relay(target_relay uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (
    exists (select 1 from public.mf_snaps s where s.relay_id = target_relay and s.recipient_id = auth.uid())
    and not exists (select 1 from public.mf_snaps s where s.relay_id = target_relay and s.viewed_at is null)
  ) or exists (
    select 1 from public.mf_transfer_deliveries d where d.relay_id = target_relay and d.recipient_id = auth.uid()
  );
$$;

drop policy if exists "mf_snaps_obj_select" on storage.objects;
create policy "mf_snaps_obj_select" on storage.objects for select to authenticated using (
  bucket_id = 'mf-snaps' and (exists (
    select 1 from public.mf_relay_payloads p where p.id::text = name and (
      p.sender_id = auth.uid() or
      exists (select 1 from public.mf_snaps s where s.relay_id = p.id and s.recipient_id = auth.uid() and s.expires_at > now()) or
      exists (select 1 from public.mf_transfer_deliveries d where d.relay_id = p.id and d.recipient_id = auth.uid() and d.expires_at > now())
    )
  ) or exists (
    select 1 from public.mf_snaps s where s.id::text = name and s.relay_id is null
      and s.delivery like 'relay%' and s.recipient_id = auth.uid() and s.expires_at > now()
  ))
);

do $$ begin
  alter publication supabase_realtime add table public.mf_transfer_deliveries;
exception when duplicate_object then null;
end $$;
