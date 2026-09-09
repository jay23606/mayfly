-- Durable activity is separate from device metadata and is disclosed only to
-- the account owner and accepted friends.
create table if not exists public.mf_user_activity (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_active_at timestamptz not null default now()
);
alter table public.mf_user_activity enable row level security;

drop policy if exists "mf_user_activity_select" on public.mf_user_activity;
create policy "mf_user_activity_select" on public.mf_user_activity for select to authenticated using (
  auth.uid() = user_id or exists (
    select 1 from public.mf_friends f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = user_id)
        or (f.addressee_id = auth.uid() and f.requester_id = user_id))
  )
);
drop policy if exists "mf_user_activity_insert" on public.mf_user_activity;
create policy "mf_user_activity_insert" on public.mf_user_activity for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "mf_user_activity_update" on public.mf_user_activity;
create policy "mf_user_activity_update" on public.mf_user_activity for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.mf_touch_activity()
returns void language sql security invoker set search_path = public as $$
  insert into public.mf_user_activity (user_id, last_active_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set last_active_at = excluded.last_active_at;
$$;
revoke all on function public.mf_touch_activity() from public;
revoke all on function public.mf_touch_activity() from anon;
grant execute on function public.mf_touch_activity() to authenticated;

create or replace function public.mf_friend_activity()
returns table(user_id uuid, last_active_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.user_id, a.last_active_at
  from public.mf_user_activity a
  where a.user_id = auth.uid() or exists (
    select 1 from public.mf_friends f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = a.user_id)
        or (f.addressee_id = auth.uid() and f.requester_id = a.user_id))
  );
$$;
revoke all on function public.mf_friend_activity() from public;
revoke all on function public.mf_friend_activity() from anon;
grant execute on function public.mf_friend_activity() to authenticated;

-- Public keys remain available to accepted friends for encrypted delivery,
-- but unrelated authenticated accounts can no longer enumerate device rows.
drop policy if exists "mf_devices_select" on public.mf_devices;
create policy "mf_devices_select" on public.mf_devices for select to authenticated using (
  revoked_at is null and (
    auth.uid() = user_id or exists (
      select 1 from public.mf_friends f
      where f.status = 'accepted'
        and ((f.requester_id = auth.uid() and f.addressee_id = user_id)
          or (f.addressee_id = auth.uid() and f.requester_id = user_id))
    )
  )
);
