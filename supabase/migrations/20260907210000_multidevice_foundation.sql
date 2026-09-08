-- Per-device identity and delivery foundation. A user's private key remains on
-- each device; this table contains only its public counterpart.
create table if not exists public.mf_devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  pubkey text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists mf_devices_user_active_idx on public.mf_devices (user_id, last_seen_at desc) where revoked_at is null;
alter table public.mf_devices enable row level security;
drop policy if exists "mf_devices_select" on public.mf_devices;
create policy "mf_devices_select" on public.mf_devices for select to authenticated using (revoked_at is null);
drop policy if exists "mf_devices_insert" on public.mf_devices;
create policy "mf_devices_insert" on public.mf_devices for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "mf_devices_update" on public.mf_devices;
create policy "mf_devices_update" on public.mf_devices for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Device-targeted encrypted delivery rows. Existing legacy rows retain NULL and
-- remain readable by every existing installation until they expire.
alter table public.mf_messages add column if not exists recipient_device_id uuid references public.mf_devices(id) on delete cascade;
alter table public.mf_messages add column if not exists message_id uuid;
create index if not exists mf_messages_device_inbox_idx on public.mf_messages (recipient_device_id, created_at);

alter table public.mf_snaps add column if not exists recipient_device_id uuid references public.mf_devices(id) on delete cascade;
alter table public.mf_snaps add column if not exists sender_device_id uuid references public.mf_devices(id) on delete set null;
alter table public.mf_snaps add column if not exists logical_id uuid;
create index if not exists mf_snaps_device_inbox_idx on public.mf_snaps (recipient_device_id, created_at desc);
create index if not exists mf_snaps_logical_idx on public.mf_snaps (logical_id);

-- A first-device-wins claim is recorded independently from each encrypted device
-- envelope. The winner is the only device allowed to consume/view the Snap.
create table if not exists public.mf_snap_claims (
  logical_id uuid primary key,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.mf_devices(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
alter table public.mf_snap_claims enable row level security;

create or replace function public.mf_claim_snap(snap_id uuid, device_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare logical uuid; owner uuid;
begin
  select logical_id, recipient_id into logical, owner from public.mf_snaps
  where id = snap_id and recipient_id = auth.uid() and recipient_device_id = device_id and viewed_at is null;
  if logical is null or owner is null then return false; end if;
  insert into public.mf_snap_claims (logical_id, recipient_id, device_id)
  values (logical, owner, device_id)
  on conflict (logical_id) do nothing;
  if not found then return false; end if;
  update public.mf_snaps set opened_at = now(), viewed_at = now()
  where logical_id = logical and recipient_id = owner and viewed_at is null;
  return true;
end;
$$;
revoke all on function public.mf_claim_snap(uuid, uuid) from public;
grant execute on function public.mf_claim_snap(uuid, uuid) to authenticated;

-- New tables need publication membership for per-device realtime delivery.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mf_devices') then
    alter publication supabase_realtime add table public.mf_devices;
  end if;
end $$;
