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
  timer        int not null default 0,             -- 0 = keep in chat; positive = view-once seconds
  delivery     text not null,                      -- 'live' (P2P) | 'relay' (encrypted Storage)
  iv           text,
  eph_pub      text,
  delivered_at timestamptz,
  opened_at    timestamptz,
  viewed_at    timestamptz,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '24 hours'
);
-- 0 means keep the Snap in the recipient's local chat history. Positive values
-- remain view-once timers. This ALTER also updates already-created installs.
alter table public.mf_snaps alter column timer set default 0;
alter table public.mf_snaps add column if not exists delivered_at timestamptz;
alter table public.mf_snaps add column if not exists opened_at timestamptz;
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
-- Story creation goes through mf_add_story so previews stay bounded and every
-- account retains only its 5 newest Stories.
create policy "mf_stories_insert" on public.mf_stories for insert with check (false);
create or replace function public.mf_add_story(
  story_id uuid, story_preview text, story_caption text, story_w int, story_h int
)
returns public.mf_stories language plpgsql security definer set search_path = public as $$
declare created public.mf_stories;
begin
  if auth.uid() is null then raise exception 'Sign in to post a Story'; end if;
  if story_preview is null or octet_length(story_preview) > 20480 then
    raise exception 'Story preview must be at most 20 KB';
  end if;
  insert into public.mf_stories (id, user_id, preview, caption, w, h, expires_at)
  values (story_id, auth.uid(), story_preview, left(coalesce(story_caption, ''), 120), story_w, story_h,
          now() + interval '24 hours')
  returning * into created;
  delete from public.mf_stories
  where id in (
    select id from public.mf_stories where user_id = auth.uid()
    order by created_at desc, id desc offset 5
  );
  return created;
end;
$$;
revoke all on function public.mf_add_story(uuid, text, text, int, int) from public;
grant execute on function public.mf_add_story(uuid, text, text, int, int) to authenticated;
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
-- mf_messages: async 1:1 chat. Each row is the message text ENCRYPTED to the
-- recipient's public key (E2E — server sees only ciphertext). It's ephemeral: the
-- recipient decrypts + stores it in their own device history, then deletes the row.
-- So the table only ever holds messages that haven't been delivered yet.
-- ---------------------------------------------------------------------------
create table if not exists public.mf_messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.mf_profiles(id) on delete cascade,
  recipient_id uuid not null references public.mf_profiles(id) on delete cascade,
  iv           text not null,
  eph_pub      text not null,
  body         text not null,                     -- base64 AES-GCM ciphertext
  created_at   timestamptz not null default now()
);
create index if not exists mf_messages_inbox_idx on public.mf_messages (recipient_id, created_at);
alter table public.mf_messages enable row level security;
drop policy if exists "mf_messages_select" on public.mf_messages;
create policy "mf_messages_select" on public.mf_messages for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);
drop policy if exists "mf_messages_insert" on public.mf_messages;
create policy "mf_messages_insert" on public.mf_messages for insert with check (auth.uid() = sender_id);
drop policy if exists "mf_messages_delete" on public.mf_messages;
create policy "mf_messages_delete" on public.mf_messages for delete
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

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
-- Members may rename a group through this narrow RPC. They cannot use it to
-- change membership, ownership, or any other group field.
create or replace function public.mf_rename_group(gid uuid, new_name text)
returns text language plpgsql security definer set search_path = public as $$
declare clean_name text := left(trim(coalesce(new_name, '')), 60);
begin
  if auth.uid() is null or not public.mf_is_group_member(gid, auth.uid()) then
    raise exception 'Only group members can rename a group';
  end if;
  if clean_name = '' then raise exception 'Group name cannot be empty'; end if;
  update public.mf_groups set name = clean_name where id = gid;
  return clean_name;
end;
$$;
revoke all on function public.mf_rename_group(uuid, text) from public;
grant execute on function public.mf_rename_group(uuid, text) to authenticated;
create or replace function public.mf_remove_group_member(gid uuid, target_uid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.mf_is_group_member(gid, auth.uid()) then
    raise exception 'Only group members can remove people';
  end if;
  if target_uid = auth.uid() then
    raise exception 'Use leave group to remove yourself';
  end if;
  if not public.mf_is_group_member(gid, target_uid) then
    raise exception 'That person is not in this group';
  end if;
  delete from public.mf_group_members where group_id = gid and user_id = target_uid;
end;
$$;
revoke all on function public.mf_remove_group_member(uuid, uuid) from public;
grant execute on function public.mf_remove_group_member(uuid, uuid) to authenticated;
drop policy if exists "mf_groups_update" on public.mf_groups;
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
-- mf_push_subscriptions: Web Push endpoints (one row per browser). A Supabase Edge
-- Function reads these via the service role to fan out notifications for 1:1 messages
-- and calls. No message content is ever stored or pushed — only "you have something";
-- the client opens and decrypts. Users manage only their own rows.
-- ---------------------------------------------------------------------------
create table if not exists public.mf_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists mf_push_subs_user_idx on public.mf_push_subscriptions (user_id);
alter table public.mf_push_subscriptions enable row level security;
drop policy if exists "mf_push_subs_all" on public.mf_push_subscriptions;
create policy "mf_push_subs_all" on public.mf_push_subscriptions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- mf_call_rings: a 1:1 call is ephemeral WebRTC signaling with no DB row, so the caller
-- inserts a short-lived ring here purely to give the push webhook something to fire on.
-- Deleted when the call ends; a boot sweep clears any the caller left behind.
create table if not exists public.mf_call_rings (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'audio',
  created_at timestamptz not null default now()
);
create index if not exists mf_call_rings_callee_idx on public.mf_call_rings (callee_id);
alter table public.mf_call_rings enable row level security;
drop policy if exists "mf_call_rings_insert" on public.mf_call_rings;
create policy "mf_call_rings_insert" on public.mf_call_rings for insert with check (auth.uid() = caller_id);
drop policy if exists "mf_call_rings_select" on public.mf_call_rings;
create policy "mf_call_rings_select" on public.mf_call_rings for select
  using (auth.uid() = caller_id or auth.uid() = callee_id);
drop policy if exists "mf_call_rings_delete" on public.mf_call_rings;
create policy "mf_call_rings_delete" on public.mf_call_rings for delete
  using (auth.uid() = caller_id or auth.uid() = callee_id);

-- ---------------------------------------------------------------------------
-- Site administration: only the immutable auth ID for ihvnolegs can invoke this
-- RPC. It removes a Mayfly account, its relay blobs, and then its auth record;
-- the foreign-key cascades erase the related Mayfly rows (friends, messages,
-- Stories, groups it created, memberships, push subscriptions, and call rings).
-- ---------------------------------------------------------------------------
create or replace function public.mf_admin_delete_user(target_id uuid)
returns void language plpgsql security definer set search_path = public, auth, storage, pg_temp as $$
declare
  admin_id constant uuid := '2f43626a-3056-402d-9daf-b0de5193a2f8';
begin
  if auth.uid() <> admin_id then raise exception 'Not authorized'; end if;
  if target_id is null or target_id = admin_id then raise exception 'The administrator account cannot be removed here'; end if;
  if not exists (select 1 from public.mf_profiles where id = target_id) then raise exception 'Mayfly user not found'; end if;

  delete from storage.objects
  where bucket_id = 'mf-snaps'
    and name in (select id::text from public.mf_snaps where sender_id = target_id or recipient_id = target_id);

  delete from auth.users where id = target_id;
end;
$$;
revoke all on function public.mf_admin_delete_user(uuid) from public;
grant execute on function public.mf_admin_delete_user(uuid) to authenticated;

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
  foreach t in array array['mf_snaps','mf_friends','mf_stories','mf_messages'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
