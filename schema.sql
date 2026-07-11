-- mayfly — Supabase schema + Row Level Security
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Fully idempotent: safe to re-run (create-if-not-exists + drop/create policies).
--
-- mayfly shares the SAME Supabase project as instamegle, so EVERY object here is
-- mf_-prefixed to avoid collisions. Design: snaps are ephemeral + directed.
--  • Recipient ONLINE  → the full image streams peer-to-peer, never touching the DB.
--  • Recipient OFFLINE → the image is encrypted to the recipient's public key and
--    parked as ciphertext in the private "mf-snaps" Storage bucket (zero-knowledge).
-- The only image bytes this DB ever holds is a tiny ~24px blurred "preview" (LQIP).
-- A snap row is HARD-DELETED the moment it's viewed (or after it expires).

-- ---------------------------------------------------------------------------
-- mf_profiles: one row per user, id === auth.users.id
-- pubkey = the device's ECDH P-256 public key (JWK). The private half never leaves
-- the device (IndexedDB). The app self-heals a missing profile on login, so there's
-- no signup trigger here (we don't touch the shared auth.users triggers).
-- ---------------------------------------------------------------------------
create table if not exists public.mf_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  avatar     text not null default '',
  pubkey     text not null default '',
  created_at timestamptz not null default now()
);
alter table public.mf_profiles enable row level security;
drop policy if exists "mf_profiles_select" on public.mf_profiles;
create policy "mf_profiles_select" on public.mf_profiles for select using (true);
drop policy if exists "mf_profiles_insert" on public.mf_profiles;
create policy "mf_profiles_insert" on public.mf_profiles for insert with check (auth.uid() = id);
drop policy if exists "mf_profiles_update" on public.mf_profiles;
create policy "mf_profiles_update" on public.mf_profiles for update using (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- mf_friends: symmetric friendship, one row per pair (requester -> addressee)
-- ---------------------------------------------------------------------------
create table if not exists public.mf_friends (
  requester_id uuid not null references public.mf_profiles(id) on delete cascade,
  addressee_id uuid not null references public.mf_profiles(id) on delete cascade,
  status       text not null default 'pending',   -- pending | accepted
  created_at   timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
alter table public.mf_friends enable row level security;
drop policy if exists "mf_friends_select" on public.mf_friends;
create policy "mf_friends_select" on public.mf_friends for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
drop policy if exists "mf_friends_insert" on public.mf_friends;
create policy "mf_friends_insert" on public.mf_friends for insert
  with check (auth.uid() = requester_id and status = 'pending');
drop policy if exists "mf_friends_update" on public.mf_friends;
create policy "mf_friends_update" on public.mf_friends for update using (auth.uid() = addressee_id);
drop policy if exists "mf_friends_delete" on public.mf_friends;
create policy "mf_friends_delete" on public.mf_friends for delete
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- ---------------------------------------------------------------------------
-- mf_snaps: directed, ephemeral. preview (LQIP) only; full image is P2P or encrypted.
-- ---------------------------------------------------------------------------
create table if not exists public.mf_snaps (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.mf_profiles(id) on delete cascade,
  recipient_id uuid not null references public.mf_profiles(id) on delete cascade,
  preview      text not null,
  caption      text not null default '',
  w            int,
  h            int,
  timer        int not null default 5,
  delivery     text not null,                      -- 'live' (P2P) | 'relay' (encrypted Storage)
  iv           text,
  eph_pub      text,
  viewed_at    timestamptz,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '24 hours'
);
create index if not exists mf_snaps_inbox_idx on public.mf_snaps (recipient_id, created_at desc);
create index if not exists mf_snaps_sender_idx on public.mf_snaps (sender_id);
alter table public.mf_snaps enable row level security;
drop policy if exists "mf_snaps_select" on public.mf_snaps;
create policy "mf_snaps_select" on public.mf_snaps for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);
drop policy if exists "mf_snaps_insert" on public.mf_snaps;
create policy "mf_snaps_insert" on public.mf_snaps for insert with check (auth.uid() = sender_id);
drop policy if exists "mf_snaps_update" on public.mf_snaps;
create policy "mf_snaps_update" on public.mf_snaps for update using (auth.uid() = recipient_id);
drop policy if exists "mf_snaps_delete" on public.mf_snaps;
create policy "mf_snaps_delete" on public.mf_snaps for delete
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- ---------------------------------------------------------------------------
-- mf_streaks: consecutive-day snap streak per pair (canonical a<b)
-- ---------------------------------------------------------------------------
create table if not exists public.mf_streaks (
  user_a  uuid not null references public.mf_profiles(id) on delete cascade,
  user_b  uuid not null references public.mf_profiles(id) on delete cascade,
  count   int not null default 0,
  last_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
alter table public.mf_streaks enable row level security;
drop policy if exists "mf_streaks_select" on public.mf_streaks;
create policy "mf_streaks_select" on public.mf_streaks for select
  using (auth.uid() = user_a or auth.uid() = user_b);

create or replace function public.mf_bump_streak(other uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  a uuid := least(auth.uid(), other);
  b uuid := greatest(auth.uid(), other);
begin
  if auth.uid() is null or other is null or a = b then return; end if;
  insert into public.mf_streaks (user_a, user_b, count, last_at)
  values (a, b, 1, now())
  on conflict (user_a, user_b) do update
    set count = case
                  when (current_date - mf_streaks.last_at::date) = 0 then mf_streaks.count
                  when (current_date - mf_streaks.last_at::date) = 1 then mf_streaks.count + 1
                  else 1
                end,
        last_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- mf_stories: 24h ephemeral posts, visible to friends. Full image is P2P (or a
-- blurred LQIP when the author is offline); replayable, with a viewer list.
-- ---------------------------------------------------------------------------
create or replace function public.mf_is_friend(other uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.mf_friends f where f.status = 'accepted'
    and ((f.requester_id = auth.uid() and f.addressee_id = other)
      or (f.requester_id = other and f.addressee_id = auth.uid())));
$$;

create table if not exists public.mf_stories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.mf_profiles(id) on delete cascade,
  preview    text not null,
  caption    text not null default '',
  w          int,
  h          int,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index if not exists mf_stories_active_idx on public.mf_stories (expires_at, user_id);
alter table public.mf_stories enable row level security;
drop policy if exists "mf_stories_select" on public.mf_stories;
create policy "mf_stories_select" on public.mf_stories for select
  using (auth.uid() = user_id or public.mf_is_friend(user_id));
drop policy if exists "mf_stories_insert" on public.mf_stories;
create policy "mf_stories_insert" on public.mf_stories for insert with check (auth.uid() = user_id);
drop policy if exists "mf_stories_delete" on public.mf_stories;
create policy "mf_stories_delete" on public.mf_stories for delete using (auth.uid() = user_id);

create table if not exists public.mf_story_views (
  story_id  uuid not null references public.mf_stories(id) on delete cascade,
  viewer_id uuid not null references public.mf_profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);
alter table public.mf_story_views enable row level security;
drop policy if exists "mf_story_views_select" on public.mf_story_views;
create policy "mf_story_views_select" on public.mf_story_views for select using (
  auth.uid() = viewer_id
  or auth.uid() = (select user_id from public.mf_stories s where s.id = story_id));
drop policy if exists "mf_story_views_insert" on public.mf_story_views;
create policy "mf_story_views_insert" on public.mf_story_views for insert with check (auth.uid() = viewer_id);

-- ---------------------------------------------------------------------------
-- Groups: persistent named group chats + mesh video calls. Group TEXT is ephemeral
-- Realtime Broadcast (never stored); group VIDEO is a full P2P mesh.
-- ---------------------------------------------------------------------------
create table if not exists public.mf_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  created_by uuid not null references public.mf_profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.mf_group_members (
  group_id uuid not null references public.mf_groups(id) on delete cascade,
  user_id  uuid not null references public.mf_profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists mf_group_members_user_idx on public.mf_group_members (user_id);

create or replace function public.mf_is_group_member(gid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.mf_group_members where group_id = gid and user_id = uid);
$$;

alter table public.mf_groups enable row level security;
alter table public.mf_group_members enable row level security;
drop policy if exists "mf_groups_select" on public.mf_groups;
create policy "mf_groups_select" on public.mf_groups for select using (public.mf_is_group_member(id, auth.uid()) or auth.uid() = created_by);
drop policy if exists "mf_groups_insert" on public.mf_groups;
create policy "mf_groups_insert" on public.mf_groups for insert with check (auth.uid() = created_by);
drop policy if exists "mf_groups_delete" on public.mf_groups;
create policy "mf_groups_delete" on public.mf_groups for delete using (auth.uid() = created_by);
drop policy if exists "mf_gm_select" on public.mf_group_members;
create policy "mf_gm_select" on public.mf_group_members for select using (public.mf_is_group_member(group_id, auth.uid()));
drop policy if exists "mf_gm_insert" on public.mf_group_members;
create policy "mf_gm_insert" on public.mf_group_members for insert with check (
  public.mf_is_group_member(group_id, auth.uid())
  or auth.uid() = (select created_by from public.mf_groups g where g.id = group_id));
drop policy if exists "mf_gm_delete" on public.mf_group_members;
create policy "mf_gm_delete" on public.mf_group_members for delete using (
  user_id = auth.uid() or auth.uid() = (select created_by from public.mf_groups g where g.id = group_id));

-- ---------------------------------------------------------------------------
-- Storage bucket for encrypted relay blobs (private; content is E2E-encrypted).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('mf-snaps', 'mf-snaps', false)
on conflict (id) do nothing;

drop policy if exists "mf_snaps_obj_insert" on storage.objects;
create policy "mf_snaps_obj_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'mf-snaps');
drop policy if exists "mf_snaps_obj_select" on storage.objects;
create policy "mf_snaps_obj_select" on storage.objects for select to authenticated
  using (bucket_id = 'mf-snaps');
drop policy if exists "mf_snaps_obj_delete" on storage.objects;
create policy "mf_snaps_obj_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'mf-snaps');

-- Realtime Authorization: private "mfgroup:<uuid>" channels are member-only. A distinct
-- prefix (not instamegle's "group:") keeps the two apps' realtime.messages policies from
-- interacting in this shared project. (Public channels — presence/signal/stories — don't
-- consult realtime.messages, so they're unaffected.)
drop policy if exists "mf_group_read" on realtime.messages;
create policy "mf_group_read" on realtime.messages for select to authenticated using (
  realtime.topic() like 'mfgroup:%'
  and public.mf_is_group_member((substring(realtime.topic() from 9))::uuid, auth.uid()));
drop policy if exists "mf_group_write" on realtime.messages;
create policy "mf_group_write" on realtime.messages for insert to authenticated with check (
  realtime.topic() like 'mfgroup:%'
  and public.mf_is_group_member((substring(realtime.topic() from 9))::uuid, auth.uid()));

-- ---------------------------------------------------------------------------
-- Realtime: recipients get new snaps live; senders learn when a snap was opened
-- (row deleted); friends see requests + stories live. Idempotent add.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['mf_snaps','mf_friends','mf_stories'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
