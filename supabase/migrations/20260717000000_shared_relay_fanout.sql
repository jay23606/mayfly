-- A fan-out relay keeps one encrypted media payload and one small, recipient-
--specific encrypted key envelope in each mf_snaps row.
create table if not exists public.mf_relay_payloads (
  id         uuid primary key,
  sender_id  uuid not null references public.mf_profiles(id) on delete cascade,
  content_iv text not null,
  mime       text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists mf_relay_payloads_sender_expiry_idx on public.mf_relay_payloads (sender_id, expires_at);

alter table public.mf_snaps add column if not exists relay_id uuid references public.mf_relay_payloads(id) on delete cascade;
alter table public.mf_snaps add column if not exists wrapped_key text;
create index if not exists mf_snaps_relay_id_idx on public.mf_snaps (relay_id);

alter table public.mf_relay_payloads enable row level security;
drop policy if exists "mf_relay_payloads_select" on public.mf_relay_payloads;
create policy "mf_relay_payloads_select" on public.mf_relay_payloads for select using (
  auth.uid() = sender_id
  or (expires_at > now() and exists (
    select 1 from public.mf_snaps s where s.relay_id = public.mf_relay_payloads.id and s.recipient_id = auth.uid()
  ))
);
drop policy if exists "mf_relay_payloads_insert" on public.mf_relay_payloads;
create policy "mf_relay_payloads_insert" on public.mf_relay_payloads for insert with check (auth.uid() = sender_id);
drop policy if exists "mf_relay_payloads_delete" on public.mf_relay_payloads;
create policy "mf_relay_payloads_delete" on public.mf_relay_payloads for delete using (auth.uid() = sender_id);

-- Replaces the former bucket-wide policies. Existing per-recipient legacy relays
-- remain readable/deletable by their parties; new shared objects are readable only
-- by the sender or a recipient with an active linked Snap row.
drop policy if exists "mf_snaps_obj_insert" on storage.objects;
drop policy if exists "mf_snaps_obj_select" on storage.objects;
drop policy if exists "mf_snaps_obj_delete" on storage.objects;
create policy "mf_snaps_obj_insert" on storage.objects for insert to authenticated with check (
  bucket_id = 'mf-snaps'
  and exists (select 1 from public.mf_relay_payloads p where p.id::text = name and p.sender_id = auth.uid())
);
create policy "mf_snaps_obj_select" on storage.objects for select to authenticated using (
  bucket_id = 'mf-snaps' and (
    exists (
      select 1 from public.mf_relay_payloads p
      where p.id::text = name and (p.sender_id = auth.uid() or exists (
        select 1 from public.mf_snaps s where s.relay_id = p.id and s.recipient_id = auth.uid() and s.expires_at > now()
      ))
    )
    or exists (
      select 1 from public.mf_snaps s
      where s.id::text = name and s.relay_id is null and s.delivery like 'relay%'
        and (s.sender_id = auth.uid() or s.recipient_id = auth.uid())
    )
  )
);
create policy "mf_snaps_obj_delete" on storage.objects for delete to authenticated using (
  bucket_id = 'mf-snaps' and (
    exists (select 1 from public.mf_relay_payloads p where p.id::text = name and p.sender_id = auth.uid())
    or exists (
      select 1 from public.mf_snaps s
      where s.id::text = name and s.relay_id is null and s.delivery like 'relay%'
        and (s.sender_id = auth.uid() or s.recipient_id = auth.uid())
    )
  )
);
